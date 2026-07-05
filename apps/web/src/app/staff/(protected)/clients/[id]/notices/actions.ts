'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { NOTICE_STATUS_TRANSITIONS } from './transitions';

const KIND_VALUES = [
  'USTA', 'UST_JAHR', 'EST', 'KST',
  'GEWST_MESSBESCHEID', 'GEWST', 'LSTA',
  'FESTSTELLUNG', 'ZERLEGUNG', 'SONSTIGE',
] as const;

const Schema = z.object({
  clientId: z.string().uuid(),
  kind: z.enum(KIND_VALUES),
  period: z.string().min(1).max(20),
  noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fileNumber: z.string().max(100).optional().nullable(),
  assessedAmount: z.string().optional().nullable(),
  expectedAmount: z.string().optional().nullable(),
  prepaidAmount: z.string().optional().nullable(),
  payAmount: z.string().optional().nullable(),
  reviewNotes: z.string().max(10_000).optional().nullable(),
});

function parseDecimal(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined || s.trim() === '') return undefined;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return n.toFixed(2);
}

export async function createNoticeAction(formData: FormData): Promise<void> {
  // void/throw-Form-Action: Gate liefert die Fehlermeldung als Wurf (Vertrag bleibt).
  const g = await staffActionGuard();
  if (!g.ok) throw new Error(g.error);
  const { tenantId, staffId, ctx, session } = g;

  const parsed = Schema.safeParse({
    clientId: formData.get('clientId'),
    kind: formData.get('kind'),
    period: formData.get('period'),
    noticeDate: formData.get('noticeDate'),
    fileNumber: formData.get('fileNumber'),
    assessedAmount: formData.get('assessedAmount'),
    expectedAmount: formData.get('expectedAmount'),
    prepaidAmount: formData.get('prepaidAmount'),
    payAmount: formData.get('payAmount'),
    reviewNotes: formData.get('reviewNotes'),
  });
  if (!parsed.success) throw new Error('Validierungsfehler.');

  const d = parsed.data;
  const noticeDate = new Date(d.noticeDate + 'T00:00:00.000Z');
  // Bekanntgabefiktion 3 Tage + 1 Monat = +33 Tage. Trigger setzt das gleiche
  // im DB-Default — wir berechnen es trotzdem App-seitig für Kohärenz.
  const appealDeadline = new Date(noticeDate.getTime() + 33 * 24 * 60 * 60 * 1000);

  await withTenantContext(
    ctx,
    async (tx) => {
      await assertClientAccessTx(tx, session, d.clientId);
      // Q-5: clientId muss im aktuellen Tenant existieren — sonst kann ein
      // UI-Bug / direkter API-Call eine fremde clientId persistieren.
      await assertClientInTenant(tx, d.clientId);
      // Auto-Match: bestehende TaxFiling für gleichen Mandant/Steuerart/Zeitraum?
      // Wenn ja, übernehmen wir deren Soll-Wert als expectedAmount (sofern nicht
      // explizit gesetzt) und verknüpfen die beiden Datensätze.
      const matchingFiling = await tx.taxFiling.findUnique({
        where: {
          tenantId_clientId_kind_period: {
            tenantId,
            clientId: d.clientId,
            kind: d.kind,
            period: d.period,
          },
        },
      });
      const expectedFromFiling = matchingFiling?.expectedAssessed
        ? matchingFiling.expectedAssessed.toFixed(2)
        : undefined;

      const created = await tx.taxNotice.create({
        data: {
          tenantId,
          clientId: d.clientId,
          kind: d.kind,
          period: d.period,
          noticeDate,
          appealDeadline,
          fileNumber: d.fileNumber ?? null,
          assessedAmount: parseDecimal(d.assessedAmount),
          expectedAmount: parseDecimal(d.expectedAmount) ?? expectedFromFiling,
          prepaidAmount: parseDecimal(d.prepaidAmount),
          payAmount: parseDecimal(d.payAmount),
          reviewNotes: d.reviewNotes ?? null,
          filingId: matchingFiling?.id ?? null,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_notice.create',
        resourceType: 'tax_notice',
        resourceId: created.id,
        after: {
          kind: d.kind,
          period: d.period,
          noticeDate: d.noticeDate,
          filingId: matchingFiling?.id ?? null,
        },
      });
    },
  );

  revalidatePath(`/staff/clients/${d.clientId}/notices`);
  redirect(`/staff/clients/${d.clientId}/notices`);
}

const NOTICE_STATUS_VALUES = [
  'NEU', 'GEPRUEFT', 'EINSPRUCH',
  'ABGEHOLFEN', 'ZURUECKGEWIESEN', 'RECHTSKRAEFTIG',
] as const;

/**
 * Status-Transition für Bescheide (Quick-Actions im Bescheid-Postfach).
 * Erlaubte Übergänge: NOTICE_STATUS_TRANSITIONS (./transitions.ts). Relevanz:
 * erst ab GEPRUEFT erscheint der Bescheid im Mandantenportal. Side-Effects:
 * GEPRUEFT setzt reviewedAt/-By, EINSPRUCH appealFiledAt, ABGEHOLFEN/
 * ZURUECKGEWIESEN appealResolvedAt; zurück auf NEU räumt den Prüfvermerk.
 */
export async function updateNoticeStatusAction(input: {
  noticeId: string;
  status: string;
}): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z
    .object({ noticeId: z.string().uuid(), status: z.enum(NOTICE_STATUS_VALUES) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { noticeId, status } = parsed.data;

  let clientId: string | null = null;
  let result: ActionResult;
  try {
    result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
    const before = await tx.taxNotice.findFirst({
      where: { id: noticeId, tenantId },
      select: { id: true, status: true, clientId: true, reviewedAt: true, appealFiledAt: true },
    });
    if (!before) return { ok: false, error: 'Bescheid nicht gefunden.' };
    clientId = before.clientId;
    await assertClientAccessTx(tx, session, before.clientId);

    const allowed = NOTICE_STATUS_TRANSITIONS[before.status] ?? [];
    if (!allowed.includes(status)) {
      return { ok: false, error: `Statuswechsel ${before.status} → ${status} ist nicht zulässig.` };
    }

    const now = new Date();
    const updated = await tx.taxNotice.update({
      where: { id: noticeId },
      data: {
        status,
        ...(status === 'GEPRUEFT' ? { reviewedAt: now, reviewedBy: staffId } : {}),
        ...(status === 'NEU' ? { reviewedAt: null, reviewedBy: null } : {}),
        ...(status === 'EINSPRUCH'
          ? {
              appealFiledAt: before.appealFiledAt ?? now,
              // Direkt-Einspruch aus NEU impliziert die Prüfung.
              ...(before.reviewedAt ? {} : { reviewedAt: now, reviewedBy: staffId }),
            }
          : {}),
        ...(status === 'ABGEHOLFEN' || status === 'ZURUECKGEWIESEN'
          ? { appealResolvedAt: now }
          : {}),
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tax_notice.status',
      resourceType: 'tax_notice',
      resourceId: noticeId,
      before: { status: before.status },
      after: { status: updated.status },
    });
    return { ok: true };
    });
  } catch (e) {
    return toActionError(e);
  }

  if (result.ok && clientId) revalidatePath(`/staff/clients/${clientId}/notices`);
  return result;
}
