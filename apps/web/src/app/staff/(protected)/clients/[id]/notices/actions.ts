'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import {
  appealDeadline,
  appealDeadlineForPostAbroad,
  appealDeadlineFromNotification,
  berlinCalendarDate,
  type GermanRegion,
} from '@taxtronik/tax';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { planNoticeTransition } from './notice-transition';

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YmdSchema = z
  .string()
  .regex(YMD_PATTERN)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Ungültiges Kalenderdatum.');

const KIND_VALUES = [
  'USTA',
  'UST_JAHR',
  'EST',
  'KST',
  'GEWST_MESSBESCHEID',
  'GEWST',
  'LSTA',
  'FESTSTELLUNG',
  'ZERLEGUNG',
  'SONSTIGE',
] as const;
const DELIVERY_METHODS = [
  'POST',
  'POST_ABROAD',
  'ELECTRONIC',
  'DATA_RETRIEVAL',
  'FORMAL',
  'PERSONAL',
  'OTHER',
] as const;

const Schema = z.object({
  clientId: z.string().uuid(),
  kind: z.enum(KIND_VALUES),
  period: z.string().min(1).max(20),
  noticeDate: YmdSchema,
  deliveryMethod: z.enum(DELIVERY_METHODS),
  legalRemedyInstruction: z.enum(['VALID', 'MISSING_OR_INVALID']),
  // Tatsächlicher Zugang (§ 122 Abs. 2 AO Hs. 2) — leer = Fiktion maßgeblich.
  receivedAt: z.string().pipe(YmdSchema).optional().nullable().or(z.literal('')),
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
    deliveryMethod: formData.get('deliveryMethod'),
    legalRemedyInstruction: formData.get('legalRemedyInstruction'),
    receivedAt: formData.get('receivedAt'),
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
  // Tatsächlicher Zugang: nur plausible Werte übernehmen (nicht vor dem
  // Versand-/Bereitstellungstag — ein Bescheid kann nicht vorher zugehen).
  const receivedAt =
    d.receivedAt && d.receivedAt !== '' ? new Date(d.receivedAt + 'T00:00:00.000Z') : null;
  const today = berlinCalendarDate(new Date());
  if (noticeDate > today) {
    throw new Error('Versand-/Bereitstellungstag darf nicht in der Zukunft liegen.');
  }
  if (receivedAt && receivedAt > today) {
    throw new Error('Bekanntgabe-/Zugangstag darf nicht in der Zukunft liegen.');
  }
  if (receivedAt && receivedAt.getTime() < noticeDate.getTime()) {
    throw new Error('Zugangsdatum darf nicht vor Versand/Bereitstellung liegen.');
  }
  const usesDeliveryFiction =
    d.deliveryMethod === 'POST' ||
    d.deliveryMethod === 'POST_ABROAD' ||
    d.deliveryMethod === 'ELECTRONIC' ||
    d.deliveryMethod === 'DATA_RETRIEVAL';
  if (!usesDeliveryFiction && !receivedAt) {
    throw new Error(
      'Bei förmlicher, persönlicher oder sonstiger Bekanntgabe ist der rechtlich maßgebliche Bekanntgabetag erforderlich.',
    );
  }
  const legalRemedyInstructionValid = d.legalRemedyInstruction === 'VALID';

  await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, d.clientId);
    // Q-5: clientId muss im aktuellen Tenant existieren — sonst kann ein
    // UI-Bug / direkter API-Call eine fremde clientId persistieren.
    await assertClientInTenant(tx, d.clientId);
    const regionRow = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'tax_region' } },
      select: { value: true },
    });
    const regionValue = regionRow?.value as { region?: string } | null | undefined;
    const region = (regionValue?.region ?? null) as GermanRegion | null;
    // Post und elektronische Übermittlung: § 122 Abs. 2/2a AO; Abruf:
    // § 122a Abs. 4 AO. Jeweils 4-Tage-Fiktion (Altbestand bis 2024: 3 Tage).
    // Nur § 122 Abs. 2/2a lässt einen nachweislich späteren Zugang vorgehen.
    // Förmliche/persönliche/sonstige Wege liefern den feststehenden Tag.
    // Fehlende/unrichtige Belehrung: Jahresfrist nach § 356 Abs. 2 AO.
    const appealDeadlineDate =
      d.deliveryMethod === 'POST' || d.deliveryMethod === 'ELECTRONIC'
        ? appealDeadline(noticeDate, region, receivedAt, legalRemedyInstructionValid)
        : d.deliveryMethod === 'POST_ABROAD'
          ? appealDeadlineForPostAbroad(noticeDate, region, receivedAt, legalRemedyInstructionValid)
          : d.deliveryMethod === 'DATA_RETRIEVAL'
            ? appealDeadline(noticeDate, region, null, legalRemedyInstructionValid)
            : appealDeadlineFromNotification(receivedAt!, region, legalRemedyInstructionValid);
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
        deliveryMethod: d.deliveryMethod,
        legalRemedyInstructionValid,
        receivedAt,
        appealDeadline: appealDeadlineDate,
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
        deliveryMethod: d.deliveryMethod,
        legalRemedyInstructionValid,
        receivedAt: d.receivedAt || null,
        appealDeadline: appealDeadlineDate.toISOString().slice(0, 10),
        filingId: matchingFiling?.id ?? null,
      },
    });
  });

  revalidatePath(`/staff/clients/${d.clientId}/notices`);
  redirect(`/staff/clients/${d.clientId}/notices`);
}

const NOTICE_STATUS_VALUES = [
  'NEU',
  'GEPRUEFT',
  'EINSPRUCH',
  'ABGEHOLFEN',
  'TEILABHILFE',
  'ZURUECKGEWIESEN',
  'KLAGE',
  'RECHTSKRAEFTIG',
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
  /** Tatsächlicher Ereignistag für fristauslösende/-wahrende Übergänge. */
  eventDate?: string;
  decisionLegalRemedyInstruction?: 'VALID' | 'MISSING_OR_INVALID';
  /**
   * Explizit bestätigte Nachweise für offene Altverfahren, deren Ereignisfelder
   * vor Einführung des Fristennachweises noch nicht gespeichert wurden.
   */
  legacyEvidence?: {
    appealFiledDate?: string;
    appealResolvedDate?: string;
    appealDecisionReceivedDate?: string;
    klageFiledDate?: string;
  };
}): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z
    .object({
      noticeId: z.string().uuid(),
      status: z.enum(NOTICE_STATUS_VALUES),
      eventDate: YmdSchema.optional(),
      decisionLegalRemedyInstruction: z.enum(['VALID', 'MISSING_OR_INVALID']).optional(),
      legacyEvidence: z
        .object({
          appealFiledDate: YmdSchema.optional(),
          appealResolvedDate: YmdSchema.optional(),
          appealDecisionReceivedDate: YmdSchema.optional(),
          klageFiledDate: YmdSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const {
    noticeId,
    status,
    eventDate: eventDateInput,
    decisionLegalRemedyInstruction,
    legacyEvidence,
  } = parsed.data;

  const needsEventDate =
    status === 'EINSPRUCH' ||
    status === 'ABGEHOLFEN' ||
    status === 'TEILABHILFE' ||
    status === 'ZURUECKGEWIESEN' ||
    status === 'KLAGE' ||
    status === 'RECHTSKRAEFTIG';
  if (needsEventDate && !eventDateInput) {
    return { ok: false, error: 'Der tatsächliche Ereignistag ist für diesen Status erforderlich.' };
  }
  const isDecisionStatus = status === 'TEILABHILFE' || status === 'ZURUECKGEWIESEN';
  const suppliesLegacyDecision = Boolean(legacyEvidence?.appealDecisionReceivedDate);
  if ((isDecisionStatus || suppliesLegacyDecision) && !decisionLegalRemedyInstruction) {
    return {
      ok: false,
      error: 'Die Rechtsbehelfsbelehrung der Einspruchsentscheidung muss geprüft werden.',
    };
  }
  const decisionLegalRemedyInstructionValid =
    isDecisionStatus || suppliesLegacyDecision ? decisionLegalRemedyInstruction === 'VALID' : null;
  const eventDate = eventDateInput ? new Date(`${eventDateInput}T00:00:00.000Z`) : null;
  const legacyAppealFiledAt = legacyEvidence?.appealFiledDate
    ? new Date(`${legacyEvidence.appealFiledDate}T00:00:00.000Z`)
    : null;
  const legacyAppealResolvedAt = legacyEvidence?.appealResolvedDate
    ? new Date(`${legacyEvidence.appealResolvedDate}T00:00:00.000Z`)
    : null;
  const legacyDecisionReceivedAt = legacyEvidence?.appealDecisionReceivedDate
    ? new Date(`${legacyEvidence.appealDecisionReceivedDate}T00:00:00.000Z`)
    : null;
  const legacyKlageFiledAt = legacyEvidence?.klageFiledDate
    ? new Date(`${legacyEvidence.klageFiledDate}T00:00:00.000Z`)
    : null;
  const submittedDates = [
    eventDate,
    legacyAppealFiledAt,
    legacyAppealResolvedAt,
    legacyDecisionReceivedAt,
    legacyKlageFiledAt,
  ].filter((date): date is Date => date !== null);
  const today = berlinCalendarDate(new Date());
  if (submittedDates.some((date) => date.getTime() > today.getTime())) {
    return { ok: false, error: 'Der Ereignistag darf nicht in der Zukunft liegen.' };
  }

  let clientId: string | null = null;
  let result: ActionResult;
  try {
    result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
      const before = await tx.taxNotice.findFirst({
        where: { id: noticeId, tenantId },
        select: {
          id: true,
          status: true,
          clientId: true,
          noticeDate: true,
          reviewedAt: true,
          appealFiledAt: true,
          appealFiledBy: true,
          appealResolvedAt: true,
          appealDecisionReceivedAt: true,
          appealDecisionLegalRemedyInstructionValid: true,
          klageDeadline: true,
          klageFiledAt: true,
          klageFiledBy: true,
        },
      });
      if (!before) return { ok: false, error: 'Bescheid nicht gefunden.' };
      clientId = before.clientId;
      await assertClientAccessTx(tx, session, before.clientId);

      const regionRow = await tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: 'tax_region' } },
        select: { value: true },
      });
      const regionValue = regionRow?.value as { region?: string } | null | undefined;
      const plan = planNoticeTransition({
        before,
        request: {
          status,
          eventDateInput,
          eventDate,
          decisionLegalRemedyInstructionValid,
          legacyEvidence,
          legacyAppealFiledAt,
          legacyAppealResolvedAt,
          legacyDecisionReceivedAt,
          legacyKlageFiledAt,
        },
        staffId,
        now: new Date(),
        region: (regionValue?.region ?? null) as GermanRegion | null,
      });
      if (!plan.ok) return plan;

      // TOCTOU-Schutz: nur aus dem gelesenen Ausgangsstatus heraus wechseln.
      // Zwei parallele, einzeln gültige Übergänge aus demselben Status würden
      // sonst appealFiledAt/reviewedAt überschreiben (§ 122 (2)-Nachweis).
      const claim = await tx.taxNotice.updateMany({
        where: { id: noticeId, status: before.status },
        data: plan.data,
      });
      if (claim.count === 0) {
        return {
          ok: false,
          error: 'Status wurde zwischenzeitlich geändert — bitte Seite neu laden.',
        };
      }
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'tax_notice', resourceId: noticeId }],
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_notice.status',
        resourceType: 'tax_notice',
        resourceId: noticeId,
        before: { status: before.status },
        after: plan.auditAfter,
      });
      return { ok: true };
    });
  } catch (e) {
    return toActionError(e);
  }

  if (result.ok && clientId) revalidatePath(`/staff/clients/${clientId}/notices`);
  return result;
}
