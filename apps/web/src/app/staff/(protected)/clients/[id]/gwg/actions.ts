'use server';

// GwG-Prüfungs-Lebenszyklus: Parsen → Service in der Tenant-Transaktion →
// Ergebnis/Revalidate. Die Fachlogik liegt in server/gwg (Review-Befund K-03):
// check-cycle.ts (Zyklus, Risikobewertung), legal-entity.ts (Rechtsträger) und
// check-decisions.ts (Übergabe, Verifikation, Ablehnung).

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { kickMailOutboxDelivery } from '@/server/mail/outbox';
import { emitN8nEvent } from '@/server/n8n/emit';
import { DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { saveRiskAnswersTx, startGwgCheckCycleTx } from '@/server/gwg/check-cycle';
import {
  rejectCheckTx,
  submitCheckForReviewTx,
  verifyCheckTx,
  type GwgVerificationResult,
} from '@/server/gwg/check-decisions';
import { saveLegalEntityDetailsTx } from '@/server/gwg/legal-entity';
import { staffActionGuard, withStaff, parseFormData } from '@/server/actions/staff-action';

import { type ActionResult, type InvalidatedIdentitySet } from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

const OpenSchema = z.object({
  clientId: z.string().uuid(),
  expectedLatestCheckId: z.union([z.literal(''), z.string().uuid()]).default(''),
  changeScope: z
    .enum(['ROUTINE', 'BENEFICIAL_OWNERS', 'REPRESENTATIVES', 'BOTH'])
    .default('ROUTINE'),
});

async function startCheckCycle(formData: FormData): Promise<ActionResult & { checkId?: string }> {
  const parsed = OpenSchema.safeParse({
    clientId: formData.get('clientId'),
    expectedLatestCheckId: formData.get('expectedLatestCheckId') ?? '',
    changeScope: formData.get('changeScope') ?? 'ROUTINE',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
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
  let representatives: unknown;
  const representativesJson = formData.get('representativesJson');
  if (typeof representativesJson !== 'string' || !representativesJson.trim()) {
    return {
      ok: false,
      error: 'Gesetzliche Vertreter müssen über erfasste Personen ausgewählt werden.',
    };
  }
  try {
    representatives = JSON.parse(representativesJson);
  } catch {
    return { ok: false, error: 'Die Vertreterliste ist ungültig.' };
  }
  const parsed = LegalEntityDetailsSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    legalForm: formData.get('legalForm'),
    registerNumber: formData.get('registerNumber') ?? '',
    registerAuthority: formData.get('registerAuthority') ?? '',
    noRegisterEntry: formData.get('noRegisterEntry') === 'on',
    representatives,
    ownershipStructureNotes: formData.get('ownershipStructureNotes'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(' ') };
  }
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
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { ctx } = g;
  const parsed = parseFormData(CheckDecisionSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Validierungsfehler — ungültige IDs.' };
  const { checkId, clientId } = parsed.data;

  try {
    await withTenantContext(ctx, (tx) => submitCheckForReviewTx(tx, { checkId, clientId }, g));
  } catch (error) {
    return toActionError(error);
  }

  // Bewusst KEIN revalidatePath der aktuellen GwG-Route: das löste den
  // In-POST-Re-Render + die hängende Form-Transition aus (UI erst nach
  // erneutem Klick aktuell). decision-forms ruft nach ok router.refresh()
  // außerhalb der Transition auf — darüber kommt auch der frische
  // reviewSnapshotHash an. Fremde Routen nur Cache-Invalidierung (ok).
  revalidatePath(`/staff/clients/onboarding/${clientId}`);
  return { ok: true };
}

export async function verifyCheckAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  // GwG-Verifikation ist die zentrale fachliche Compliance-Entscheidung. Die
  // mandatsbezogene BERUFSTRAEGER-Zuordnung ist maßgeblich; ein angestellter
  // Steuerberater benötigt dafür keine globale ADMIN/PARTNER-Rolle.
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, ctx } = g;

  if (formData.get('reviewSnapshotVersion') !== '2') {
    return {
      ok: false,
      error:
        'Der Prüfsnapshot verwendet eine ältere Fassung. Bitte Seite neu laden und alle Angaben erneut prüfen.',
    };
  }

  const parsed = parseFormData(VerifyDecisionSchema, formData);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        'Die ausdrückliche Berufsträger-Bestätigung des vollständig angezeigten Prüfsnapshots fehlt.',
    };
  }
  const { checkId, clientId, reviewSnapshotHash } = parsed.data;
  let verified: GwgVerificationResult;

  try {
    verified = await withTenantContext(ctx, (tx) =>
      verifyCheckTx(tx, { checkId, clientId, reviewSnapshotHash }, g),
    );
  } catch (e) {
    return toActionError(e);
  }

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
  return { ok: true };
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
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, ctx } = g;

  const parsed = parseFormData(RejectSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Begründung erforderlich.' };
  const { clientId } = parsed.data;

  try {
    await withTenantContext(ctx, (tx) => rejectCheckTx(tx, parsed.data, g));
  } catch (e) {
    return toActionError(e);
  }

  await emitN8nEvent('gwg.expired', { tenantId, clientId, reason: 'rejected' }, { tenantId });
  revalidatePath(`/staff/clients/${clientId}`);
  return { ok: true };
}
