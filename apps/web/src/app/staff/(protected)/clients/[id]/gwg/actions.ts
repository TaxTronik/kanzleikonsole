'use server';

// GwG-Prüfungs-Lebenszyklus: Parsen → Service in der Tenant-Transaktion →
// Ergebnis/Revalidate. Die Fachlogik liegt in server/gwg (Review-Befund K-03):
// check-cycle.ts (Zyklus, Risikobewertung), legal-entity.ts (Rechtsträger) und
// check-decisions.ts (Übergabe, Verifikation, Ablehnung).

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { kickMailOutboxDelivery } from '@/server/mail/outbox';
import { emitN8nEvent } from '@/server/n8n/emit';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { saveRiskAnswersTx, startGwgCheckCycleTx } from '@/server/gwg/check-cycle';
import { rejectCheckTx, submitCheckForReviewTx, verifyCheckTx } from '@/server/gwg/check-decisions';
import { saveLegalEntityDetailsTx } from '@/server/gwg/legal-entity';
import { staffAction, withStaff, parseFormData } from '@/server/actions/staff-action';
import { formDefault, formFlag } from '@/server/actions/form-data';

import { type ActionResult, type InvalidatedIdentitySet } from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

const OpenSchema = z.object({
  clientId: z.string().uuid(),
  expectedLatestCheckId: formDefault('', z.union([z.literal(''), z.string().uuid()]).default('')),
  changeScope: formDefault(
    'ROUTINE',
    z.enum(['ROUTINE', 'BENEFICIAL_OWNERS', 'REPRESENTATIVES', 'BOTH']).default('ROUTINE'),
  ),
});

async function startCheckCycle(formData: FormData): Promise<ActionResult & { checkId?: string }> {
  const parsed = parseFormData(OpenSchema, formData, {
    absentAsNull: true,
    errorMessage: 'Validierungsfehler.',
  });
  if (!parsed.ok) return parsed;
  const { clientId } = parsed.data;

  return withStaff((tx, staff) => startGwgCheckCycleTx(tx, parsed.data, staff), {
    // Nur Fremd-Routen invalidieren — die aktuelle GwG-Route refresht
    // StartCheckCycleForm nach ok außerhalb der Form-Transition (der
    // In-POST-Re-Render ließ die Transition sonst bis zum nächsten
    // Klick hängen).
    revalidate: [`/staff/clients/${clientId}`, `/staff/clients/onboarding/${clientId}`],
  });
}

/**
 * Zustandsbehafteter UI-Pfad für Erstanlage, Korrektur- und
 * Wiederholungsprüfungen. Review-Befund F-01: Ablehnungen (Gate, Zustand,
 * Lock) als Ergebnis statt Wurf.
 */
export async function startNewCheckCycleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { checkId?: string }> {
  return startCheckCycle(formData);
}

const AnswersSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    answers: z.record(z.string(), z.coerce.number().int().min(0).max(3)),
    expectedRevision: z.string().min(2).max(20_000),
  })
  .superRefine((value, ctx) => {
    const factorsByKey = new Map(DEFAULT_FACTORS.map((factor) => [factor.key, factor]));
    for (const key of Object.keys(value.answers)) {
      if (!factorsByKey.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', key],
          message: `Unbekannter Risikofaktor: ${key}.`,
        });
      }
    }
    for (const factor of DEFAULT_FACTORS) {
      const answer = value.answers[factor.key];
      if (answer === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', factor.key],
          message: `Risikofaktor „${factor.label}“ wurde nicht bewertet.`,
        });
      } else if (!factor.options.some((option) => option.value === answer)) {
        ctx.addIssue({
          code: 'custom',
          path: ['answers', factor.key],
          message: `Ungültige Antwort für Risikofaktor „${factor.label}“.`,
        });
      }
    }
  });

export async function saveRiskAnswersAction(input: {
  checkId: string;
  clientId: string;
  answers: Record<string, number>;
  expectedRevision: string;
}) {
  const parsed = AnswersSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }

  return withStaff((tx, staff) => saveRiskAnswersTx(tx, parsed.data, staff));
}

const LegalEntityDetailsSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    legalForm: z.string().trim().min(1).max(100),
    registerNumber: z.string().trim().max(100).optional().or(z.literal('')),
    registerAuthority: z.string().trim().max(200).optional().or(z.literal('')),
    noRegisterEntry: z.boolean(),
    representatives: z
      .array(
        z.object({
          id: z.string().uuid().nullable().optional(),
          fullName: z.string().trim().min(1).max(200),
          isNew: z.boolean().optional(),
          linkedBeneficialOwnerId: z.string().uuid().nullable().optional(),
        }),
      )
      .min(1, 'Mindestens ein Vertreter erforderlich.')
      .max(50),
    ownershipStructureNotes: z.string().trim().min(1).max(10000),
    expectedRevision: z.string().min(2).max(20_000),
  })
  .superRefine((value, ctx) => {
    if (!value.noRegisterEntry && !value.registerNumber) {
      ctx.addIssue({
        code: 'custom',
        path: ['registerNumber'],
        message: 'Registernummer erforderlich.',
      });
    }
    if (!value.noRegisterEntry && !value.registerAuthority) {
      ctx.addIssue({
        code: 'custom',
        path: ['registerAuthority'],
        message: 'Register/Registergericht erforderlich.',
      });
    }
    const ids = value.representatives.flatMap((representative) =>
      representative.id ? [representative.id] : [],
    );
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['representatives'],
        message: 'Vertreter doppelt erfasst.',
      });
    }
    const linkedOwnerIds = value.representatives.flatMap((representative) =>
      representative.linkedBeneficialOwnerId ? [representative.linkedBeneficialOwnerId] : [],
    );
    if (new Set(linkedOwnerIds).size !== linkedOwnerIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['representatives'],
        message:
          'Dieselbe wirtschaftlich berechtigte Person wurde mehrfach als Vertreterrolle verknüpft.',
      });
    }
  });

/** Vertreterliste aus dem JSON-Feld; fehlt sie oder ist sie unlesbar, gilt nur diese Meldung. */
function parseRepresentativesJson(value: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof value !== 'string' || !value.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'Gesetzliche Vertreter müssen über erfasste Personen ausgewählt werden.',
    });
    return z.NEVER;
  }
  try {
    return JSON.parse(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Die Vertreterliste ist ungültig.' });
    return z.NEVER;
  }
}

type LegalEntityDetailsFields = z.input<typeof LegalEntityDetailsSchema>;

/**
 * Formular → LegalEntityDetailsSchema (R-12): Felder wie formData.get (fehlend
 * → null, Register fehlend → '', Haken nur bei „on“). Scheitert die
 * Vertreterliste, endet die Prüfung vor dem Schema — wie bisher.
 */
const LegalEntityDetailsForm = z
  .object({
    representativesJson: z.preprocess(parseRepresentativesJson, z.unknown()),
    checkId: z.unknown(),
    clientId: z.unknown(),
    legalForm: z.unknown(),
    registerNumber: formDefault('', z.unknown()),
    registerAuthority: formDefault('', z.unknown()),
    noRegisterEntry: formFlag(),
    ownershipStructureNotes: z.unknown(),
    expectedRevision: z.unknown(),
  })
  .transform(
    // Rohwerte wie aus formData.get — erst LegalEntityDetailsSchema prüft sie.
    ({ representativesJson, ...fields }) =>
      ({ ...fields, representatives: representativesJson }) as LegalEntityDetailsFields,
  )
  .pipe(LegalEntityDetailsSchema);

export async function saveLegalEntityDetailsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    representativesChanged?: boolean;
    representatives?: Array<{
      id: string;
      fullName: string;
      position: number;
      linkedBeneficialOwnerId: string | null;
    }>;
    details?: {
      legalForm: string;
      registerNumber: string | null;
      registerAuthority: string | null;
      noRegisterEntry: boolean;
      representativeNames: string[];
      ownershipStructureNotes: string;
    };
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
    revision?: string;
  }
> {
  const parsed = parseFormData(LegalEntityDetailsForm, formData, {
    absentAsNull: true,
    errorMessage: (issues) => issues.map((i) => i.message).join(' '),
  });
  if (!parsed.ok) return parsed;
  const data = parsed.data;

  return withStaff((tx, staff) => saveLegalEntityDetailsTx(tx, data, staff));
}

const CheckDecisionSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
});

const VerifyDecisionSchema = CheckDecisionSchema.extend({
  reviewSnapshotVersion: z.literal('2'),
  reviewSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  professionalAttestation: z.literal('confirmed'),
});

/**
 * Explizite Übergabe vom vorbereitenden Mitarbeiter an den verantwortlichen
 * Berufsträger (server/gwg/check-decisions.ts).
 */
export async function submitCheckForReviewAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async (g) => {
      const { ctx } = g;
      const parsed = parseFormData(CheckDecisionSchema, formData);
      if (!parsed.ok) return { ok: false, error: 'Validierungsfehler — ungültige IDs.' };
      const { checkId, clientId } = parsed.data;

      await withTenantContext(ctx, (tx) => submitCheckForReviewTx(tx, { checkId, clientId }, g));

      // Bewusst KEIN revalidatePath der aktuellen GwG-Route: das löste den
      // In-POST-Re-Render + die hängende Form-Transition aus (UI erst nach
      // erneutem Klick aktuell). decision-forms ruft nach ok router.refresh()
      // außerhalb der Transition auf — darüber kommt auch der frische
      // reviewSnapshotHash an. Fremde Routen nur Cache-Invalidierung (ok).
      revalidatePath(`/staff/clients/onboarding/${clientId}`);
    },
  });
}

export async function verifyCheckAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  // GwG-Verifikation ist die zentrale fachliche Compliance-Entscheidung. Die
  // mandatsbezogene BERUFSTRAEGER-Zuordnung ist maßgeblich; ein angestellter
  // Steuerberater benötigt dafür keine globale ADMIN/PARTNER-Rolle.
  return staffAction({
    run: async (g) => {
      const { tenantId, ctx } = g;

      const parsed = parseFormData(VerifyDecisionSchema, formData);
      // Eine ältere Fassung des Prüfsnapshots (reviewSnapshotVersion ≠ '2')
      // weist das Formular vor allen übrigen Angaben zum Neuladen zurück.
      if (!parsed.ok && parsed.fieldErrors.reviewSnapshotVersion) {
        return {
          ok: false,
          error:
            'Der Prüfsnapshot verwendet eine ältere Fassung. Bitte Seite neu laden und alle Angaben erneut prüfen.',
        };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          error:
            'Die ausdrückliche Berufsträger-Bestätigung des vollständig angezeigten Prüfsnapshots fehlt.',
        };
      }
      const { checkId, clientId, reviewSnapshotHash } = parsed.data;

      const verified = await withTenantContext(ctx, (tx) =>
        verifyCheckTx(tx, { checkId, clientId, reviewSnapshotHash }, g),
      );

      if (verified.sendActivationWelcome) kickMailOutboxDelivery();
      // Awaited (Guardrail: Outbox-Write muss dauerhaft sein, bevor die Action
      // zurückkehrt). Der früher unbegrenzt hängende Redis-Queue-Handoff ist in
      // der Outbox selbst per Timeout gedeckelt — siehe server/n8n/outbox.ts.
      await emitN8nEvent(
        'gwg.verified',
        { tenantId, clientId, gwgCheckId: checkId, validUntil: verified.validUntil },
        { tenantId },
      );
      // Nur die Fremd-Route (Cockpit) invalidieren — die aktuelle GwG-Route
      // refresht der Client nach ok außerhalb der Form-Transition (siehe oben).
      revalidatePath(`/staff/clients/${clientId}`);
    },
  });
}

const RejectSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

export async function rejectCheckAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  return staffAction({
    run: async (g) => {
      const { tenantId, ctx } = g;

      const parsed = parseFormData(RejectSchema, formData);
      if (!parsed.ok) return { ok: false, error: 'Begründung erforderlich.' };
      const { clientId } = parsed.data;

      await withTenantContext(ctx, (tx) => rejectCheckTx(tx, parsed.data, g));

      await emitN8nEvent('gwg.expired', { tenantId, clientId, reason: 'rejected' }, { tenantId });
      revalidatePath(`/staff/clients/${clientId}`);
    },
  });
}
