'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { staffActionGuard } from '@/server/actions/staff-action';

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
  const { tenantId, staffId, ctx } = g;

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
