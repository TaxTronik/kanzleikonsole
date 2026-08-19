'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { revokeAllSessions } from '@/server/auth/revocation';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { computeRiskScore, riskValidForDays, DEFAULT_FACTORS } from '@/server/gwg/risk-score';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { gwgDecisionGateErrors } from '@/server/gwg/verification';
import {
  copyGwgSnapshotTx,
  GWG_SNAPSHOT_COPY_INCLUDE,
  lockGwgCheckLifecycleTx,
  startFreshGwgReviewTx,
} from '@/server/gwg/reverification';
import { notifyMany } from '@/server/notifications/service';
import { gwgLegalEntityRevision, gwgRiskRevision } from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';
import { syncGwgRepresentativesTx } from '@/server/gwg/representatives';
import { cancelOpenGwgInvitesTx } from '@/server/gwg-onboarding/invite-lifecycle';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  parseFormData,
} from '@/server/actions/staff-action';

import {
  invalidatedIdentitySetRevisions,
  assertGwgEditable,
  confirmUnchangedCheck,
  type ActionResult,
  type InvalidatedIdentitySet,
} from './_action-helpers';

// Stabile Typ-Importpfade fuer die Form-Komponenten dieser Route.
export type { ActionResult, InvalidatedIdentitySet, SavedBeneficialOwner } from './_action-helpers';

async function assertLatestCheckForDecision(
  tx: TxClient,
  input: { clientId: string; checkId: string },
): Promise<void> {
  const latest = await tx.gwgCheck.findFirst({
    where: { clientId: input.clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (!latest || latest.id !== input.checkId) {
    throw new ActionError(
      'Für diesen Mandanten existiert bereits eine neuere GwG-Prüfung. Die ältere Prüfung darf nicht mehr entschieden werden; bitte Seite neu laden.',
    );
  }
}

async function markGwgReviewNotificationsReadTx(
  tx: TxClient,
  input: { tenantId: string; checkId: string },
): Promise<void> {
  await tx.notification.updateMany({
    where: {
      tenantId: input.tenantId,
      kind: 'GWG_ONBOARDING_SUBMITTED',
      resourceType: 'gwg_check',
      resourceId: input.checkId,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
}

const OpenSchema = z.object({
  clientId: z.string().uuid(),
  expectedLatestCheckId: z.union([z.literal(''), z.string().uuid()]).default(''),
  changeScope: z
    .enum(['ROUTINE', 'BENEFICIAL_OWNERS', 'REPRESENTATIVES', 'BOTH'])
    .default('ROUTINE'),
});

const TERMINAL_GWG_STATUSES = ['VERIFIED', 'REJECTED', 'EXPIRED'] as const;

async function startCheckCycle(formData: FormData): Promise<ActionResult & { checkId?: string }> {
  const parsed = OpenSchema.safeParse({
    clientId: formData.get('clientId'),
    expectedLatestCheckId: formData.get('expectedLatestCheckId') ?? '',
    changeScope: formData.get('changeScope') ?? 'ROUTINE',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { clientId, expectedLatestCheckId, changeScope } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
      const latest = await tx.gwgCheck.findFirst({
        where: { clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: GWG_SNAPSHOT_COPY_INCLUDE,
      });

      if (expectedLatestCheckId) {
        if (!latest || latest.id !== expectedLatestCheckId) {
          throw new ActionError(
            'Der Prüfstatus hat sich zwischenzeitlich geändert. Bitte Seite neu laden.',
          );
        }
        if (!(TERMINAL_GWG_STATUSES as readonly string[]).includes(latest.status)) {
          throw new ActionError(
            'Für diesen Mandanten läuft bereits eine bearbeitbare GwG-Prüfung.',
          );
        }
      } else if (latest) {
        throw new ActionError(
          'Für diesen Mandanten existiert bereits eine GwG-Prüfung. Bitte Seite neu laden.',
        );
      }

      // Immer einen zeitlich neuesten Snapshot erzeugen. Der gemeinsame
      // Lifecycle-Lock verhindert Doppelklick-Duplikate; ein bisher VERIFIEDer
      // Check wird dabei fachlich korrekt EXPIRED und der Mandant bis zur neuen
      // Freigabe fail-closed deaktiviert.
      const review = await startFreshGwgReviewTx(tx, {
        tenantId,
        clientId,
        predecessorCheckId: latest?.id ?? null,
        changeScope: latest ? changeScope : 'INITIAL',
      });
      const checkId = review.reviewCheckId;
      await cancelOpenGwgInvitesTx(tx, {
        tenantId,
        clientId,
        cancelledByStaff: staffId,
      });

      const copiedSnapshot = await copyGwgSnapshotTx(tx, {
        tenantId,
        clientId,
        targetCheckId: checkId,
        source: latest,
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.open',
        resourceType: 'gwg_check',
        resourceId: checkId,
        after: {
          clientId,
          previousCheckId: latest?.id ?? null,
          previousStatus: latest?.status ?? null,
          sourceDestroyed: latest?.destroyedAt !== null && latest?.destroyedAt !== undefined,
          ...copiedSnapshot,
          invalidatedChecks: review.invalidatedChecks,
          clientDeactivated: review.clientDeactivated,
          changeScope: latest ? changeScope : 'INITIAL',
        },
      });
      return { checkId };
    },
    {
      // Nur Fremd-Routen invalidieren — die aktuelle GwG-Route refresht
      // StartCheckCycleForm nach ok außerhalb der Form-Transition (der
      // In-POST-Re-Render ließ die Transition sonst bis zum nächsten
      // Klick hängen).
      revalidate: [`/staff/clients/${clientId}`, `/staff/clients/onboarding/${clientId}`],
    },
  );
}

/** Erstanlage aus dem leeren Zustand (bestehender Server-Form-Vertrag). */
export async function openCheckAction(formData: FormData): Promise<void> {
  const result = await startCheckCycle(formData);
  if (!result.ok)
    throw new ActionError(result.error ?? 'GwG-Prüfung konnte nicht gestartet werden.');
}

/** Zustandsbehafteter UI-Pfad für Korrektur- und Wiederholungsprüfungen. */
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

  const { checkId, clientId, answers } = parsed.data;
  const result = computeRiskScore(answers);

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
    // Schmaler Select: die Zeile trägt große JSON-Spalten (Snapshots,
    // Breakdown), gebraucht werden nur Status + Risikofelder für CAS/Evidence.
    const before = await tx.gwgCheck.findFirst({
      where: { id: checkId, clientId },
      select: { status: true, riskAnswers: true, riskScore: true, riskLevel: true },
    });
    if (!before) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(before.status);
    if (gwgRiskRevision(before) !== parsed.data.expectedRevision) {
      throw new ActionError(
        'Die Risikobewertung wurde zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    // Status-CAS und fachliches Update in einem Statement. Der alte Pfad
    // schrieb zuerst nur den Review-Reset und danach die Bewertung; auf der
    // bewusst serialisierten Tenant-Tx war das ein kompletter DB-Roundtrip
    // mehr pro Klick.
    const updated = await tx.gwgCheck.updateMany({
      where: { id: checkId, clientId, status: before.status },
      data: {
        status: 'DRAFT',
        reviewSubmittedAt: null,
        reviewSubmittedBy: null,
        riskAnswers: answers,
        riskScore: result.score,
        riskLevel: result.level,
        riskBreakdown: { factors: result.breakdown } as unknown as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0) {
      throw new ActionError(
        'Der Pr\u00fcfstatus wurde parallel ge\u00e4ndert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.',
      );
    }
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.check.assess',
      resourceType: 'gwg_check',
      resourceId: checkId,
      before: { riskScore: before.riskScore, riskLevel: before.riskLevel },
      after: { riskScore: result.score, riskLevel: result.level },
    });
    return {
      reviewReset: before.status === 'IN_REVIEW',
      revision: gwgRiskRevision({
        riskAnswers: answers,
        riskScore: result.score,
        riskLevel: result.level,
      }),
    };
  });
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
  try {
    representatives =
      typeof representativesJson === 'string' && representativesJson.trim()
        ? JSON.parse(representativesJson)
        : String(formData.get('representativeNamesText') ?? '')
            .split(/\r?\n/)
            .map((fullName) => fullName.trim())
            .filter(Boolean)
            .map((fullName) => ({ id: null, fullName }));
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

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        legalForm: true,
        registerNumber: true,
        registerAuthority: true,
        noRegisterEntry: true,
        representativeNames: true,
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
        beneficialOwners: { select: { id: true, fullName: true } },
        ownershipStructureNotes: true,
        client: { select: { kind: true } },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    if (check.client.kind !== 'JURPERS' && check.client.kind !== 'PERSGES') {
      throw new ActionError(
        'Rechtsträger-Angaben sind nur bei juristischen Personen/Personengesellschaften erforderlich.',
      );
    }
    assertGwgEditable(check.status);
    if (gwgLegalEntityRevision(check) !== data.expectedRevision) {
      throw new ActionError(
        'Die Rechtsträger-Angaben wurden zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    const currentById = new Map(
      check.representatives.map((representative) => [representative.id, representative]),
    );
    const ownersById = new Map((check.beneficialOwners ?? []).map((owner) => [owner.id, owner]));
    const submittedRepresentatives = data.representatives.map((representative, position) => {
      const legacyMatch = representative.id ? null : (check.representatives[position] ?? null);
      const id = representative.id ?? legacyMatch?.id ?? randomUUID();
      const existing = currentById.get(id);
      if (representative.isNew && existing) {
        throw new ActionError('Die neue Person ist bereits vorhanden. Bitte Seite neu laden.');
      }
      if (!representative.isNew && representative.id && !existing) {
        throw new ActionError(
          'Mindestens eine ausgewählte Person gehört nicht mehr zu dieser Prüfung.',
        );
      }
      const linkedBeneficialOwnerId = representative.linkedBeneficialOwnerId ?? null;
      const linkedOwner = linkedBeneficialOwnerId ? ownersById.get(linkedBeneficialOwnerId) : null;
      if (linkedBeneficialOwnerId && !linkedOwner) {
        throw new ActionError(
          'Die verknüpfte wirtschaftlich berechtigte Person gehört nicht mehr zu dieser Prüfung.',
        );
      }
      return {
        id,
        fullName: linkedOwner
          ? linkedOwner.fullName
          : representative.fullName.trim().replace(/\s+/g, ' '),
        position,
        isNew: !existing,
        linkedBeneficialOwnerId,
      };
    });
    const representativeNames = submittedRepresentatives.map(
      (representative) => representative.fullName,
    );
    const after = {
      legalForm: data.legalForm,
      registerNumber: data.noRegisterEntry ? null : data.registerNumber || null,
      registerAuthority: data.noRegisterEntry ? null : data.registerAuthority || null,
      noRegisterEntry: data.noRegisterEntry,
      representativeNames,
      ownershipStructureNotes: data.ownershipStructureNotes,
    };
    const representativesChanged =
      check.representatives.length !== submittedRepresentatives.length ||
      check.representatives.some(
        (representative, index) =>
          representative.id !== submittedRepresentatives[index]?.id ||
          representative.position !== index ||
          representative.fullName !== submittedRepresentatives[index]?.fullName ||
          (representative.linkedBeneficialOwnerId ?? null) !==
            submittedRepresentatives[index]?.linkedBeneficialOwnerId,
      );
    const legalDetailsChanged =
      check.legalForm !== after.legalForm ||
      check.registerNumber !== after.registerNumber ||
      check.registerAuthority !== after.registerAuthority ||
      check.noRegisterEntry !== after.noRegisterEntry ||
      check.ownershipStructureNotes !== after.ownershipStructureNotes;
    const savedRepresentatives = submittedRepresentatives.map(
      ({ id, fullName, position, linkedBeneficialOwnerId }) => ({
        id,
        fullName,
        position,
        linkedBeneficialOwnerId,
      }),
    );
    if (!legalDetailsChanged && !representativesChanged) {
      await confirmUnchangedCheck(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      return {
        reviewReset: false,
        representativesChanged: false,
        representatives: savedRepresentatives,
        details: after,
        revision: gwgLegalEntityRevision({ ...after, representatives: savedRepresentatives }),
      };
    }
    // Wie bei der Risikobewertung: Review-Reset + Fachwerte atomar in einem
    // CAS-Update statt in zwei seriellen Statements speichern.
    const updated = await tx.gwgCheck.updateMany({
      where: { id: data.checkId, clientId: data.clientId, status: check.status },
      data: {
        status: 'DRAFT',
        reviewSubmittedAt: null,
        reviewSubmittedBy: null,
        riskLevel: null,
        riskScore: null,
        riskAnswers: Prisma.DbNull,
        riskBreakdown: Prisma.DbNull,
        ...after,
      },
    });
    if (updated.count === 0) {
      throw new ActionError(
        'Der Pr\u00fcfstatus wurde parallel ge\u00e4ndert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.',
      );
    }
    const representativeSync = representativesChanged
      ? await syncGwgRepresentativesTx(tx, {
          checkId: data.checkId,
          currentRepresentatives: check.representatives.map((representative) => ({
            ...representative,
            linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId ?? null,
          })),
          submittedRepresentatives,
        })
      : { invalidatedIdentityDocuments: 0, invalidatedIdentityDocumentSetIds: [] };
    const { invalidatedIdentityDocuments, invalidatedIdentityDocumentSetIds } = representativeSync;
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      invalidatedIdentityDocumentSetIds,
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.legal_entity_details.update',
      resourceType: 'gwg_check',
      resourceId: data.checkId,
      before: {
        legalForm: check.legalForm,
        registerNumber: check.registerNumber,
        registerAuthority: check.registerAuthority,
        noRegisterEntry: check.noRegisterEntry,
        representativeNames: check.representativeNames,
        ownershipStructureNotes: check.ownershipStructureNotes,
      },
      after: {
        ...after,
        representatives: submittedRepresentatives.map(
          ({ id, fullName, position, linkedBeneficialOwnerId }) => ({
            id,
            fullName,
            position,
            linkedBeneficialOwnerId,
          }),
        ),
        invalidatedIdentityDocuments,
      },
    });
    return {
      reviewReset: check.status === 'IN_REVIEW',
      representativesChanged,
      representatives: savedRepresentatives,
      details: after,
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
      revision: gwgLegalEntityRevision({ ...after, representatives: savedRepresentatives }),
    };
  });
}

const CheckDecisionSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
});

const VerifyDecisionSchema = CheckDecisionSchema.extend({
  reviewSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  professionalAttestation: z.literal('confirmed'),
});

/**
 * Explizite Übergabe vom vorbereitenden Mitarbeiter an den verantwortlichen
 * Berufsträger. Anders als der frühere Statuswechsel beim Score-Speichern
 * prüft dieser Übergang den vollständigen, gespeicherten Snapshot.
 */
export async function submitCheckForReviewAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;
  const parsed = parseFormData(CheckDecisionSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Validierungsfehler — ungültige IDs.' };
  const { checkId, clientId } = parsed.data;

  try {
    await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
      const check = await tx.gwgCheck.findFirst({
        where: { id: checkId, clientId },
        include: {
          client: { select: { id: true, kind: true, name: true } },
          beneficialOwners: true,
          representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          idDocuments: {
            include: {
              document: {
                select: {
                  id: true,
                  clientId: true,
                  classification: true,
                  deletedAt: true,
                  gwgDestructionRequestedAt: true,
                  gwgDestroyedAt: true,
                  versions: {
                    orderBy: { versionNo: 'desc' },
                    take: 1,
                    select: { scanStatus: true, scanCompletedAt: true },
                  },
                },
              },
            },
          },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      await assertLatestCheckForDecision(tx, { clientId, checkId });
      if (check.status === 'IN_REVIEW') return;
      if (check.status !== 'DRAFT') {
        throw new ActionError('Nur ein Entwurf kann zur Freigabe eingereicht werden.');
      }
      const decisionErrors = gwgDecisionGateErrors(
        {
          ...check,
          checkId,
          clientId,
          clientKind: check.client.kind,
        },
        DEFAULT_FACTORS.map((factor) => factor.key),
      );
      if (decisionErrors.length > 0) throw new ActionError(decisionErrors.join(' '));

      const reviewers = await tx.clientResponsibility.findMany({
        where: {
          clientId,
          role: 'BERUFSTRAEGER',
          staff: { tenantId, active: true, roles: { some: {} } },
        },
        select: { staffId: true },
      });
      const reviewerIds = Array.from(new Set(reviewers.map((row) => row.staffId)));
      if (reviewerIds.length === 0) {
        throw new ActionError(
          'Bitte zuerst einen verantwortlichen Berufsträger in den Stammdaten zuordnen.',
        );
      }

      const submittedAt = new Date();
      const claim = await tx.gwgCheck.updateMany({
        where: { id: checkId, clientId, status: 'DRAFT' },
        data: {
          status: 'IN_REVIEW',
          reviewSubmittedAt: submittedAt,
          reviewSubmittedBy: staffId,
        },
      });
      if (claim.count === 0) {
        throw new ActionError('Der Prüfstatus hat sich geändert — bitte Seite neu laden.');
      }
      await cancelOpenGwgInvitesTx(tx, {
        tenantId,
        clientId,
        cancelledByStaff: staffId,
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.submit_for_review',
        resourceType: 'gwg_check',
        resourceId: checkId,
        after: { reviewSubmittedAt: submittedAt.toISOString(), reviewerIds },
      });
      await notifyMany(tx, reviewerIds, {
        tenantId,
        kind: 'GWG_ONBOARDING_SUBMITTED',
        title: 'GwG-Prüfung zur Freigabe',
        body: `${check.client.name} wurde fachlich vorbereitet und wartet auf Ihre Freigabe.`,
        href: `/staff/clients/${clientId}/gwg`,
        resourceType: 'gwg_check',
        resourceId: checkId,
      });
    });
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
  const { tenantId, staffId, ctx } = g;

  const parsed = parseFormData(VerifyDecisionSchema, formData);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        'Die ausdrückliche Berufsträger-Bestätigung des vollständig angezeigten Prüfsnapshots fehlt.',
    };
  }
  const { checkId, clientId, reviewSnapshotHash } = parsed.data;
  let verifiedValidUntil: string | null = null;

  try {
    await withTenantContext(ctx, async (tx) => {
      // Defense in Depth: Zuordnung, Tenant, aktives Konto und mindestens eine
      // weiterhin gültige Staff-Rolle werden zum Entscheidungszeitpunkt geprüft.
      const isBerufstraeger = await tx.clientResponsibility.findFirst({
        where: {
          clientId,
          staffId,
          role: 'BERUFSTRAEGER',
          staff: { tenantId, active: true, roles: { some: {} } },
        },
        select: { id: true },
      });
      if (!isBerufstraeger) {
        throw new ActionError(
          'Nur der für diesen Mandanten zugeordnete Berufsträger darf die GwG-Prüfung verifizieren.',
        );
      }

      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
      const check = await tx.gwgCheck.findFirst({
        where: { id: checkId, clientId },
        include: {
          client: {
            select: {
              id: true,
              kind: true,
              name: true,
              street: true,
              postalCode: true,
              city: true,
              countryIso: true,
              vatId: true,
            },
          },
          beneficialOwners: true,
          representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          idDocuments: {
            include: {
              document: {
                select: {
                  id: true,
                  clientId: true,
                  classification: true,
                  deletedAt: true,
                  gwgDestructionRequestedAt: true,
                  gwgDestroyedAt: true,
                  versions: {
                    orderBy: { versionNo: 'desc' },
                    take: 1,
                    select: { scanStatus: true, scanCompletedAt: true },
                  },
                },
              },
            },
          },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      await assertLatestCheckForDecision(tx, { clientId, checkId });
      if (check.status !== 'IN_REVIEW') {
        throw new ActionError(
          'GwG-Check ist nicht mehr im Prüfstatus. Bitte den aktuellen Snapshot neu öffnen.',
        );
      }
      if (!check.reviewSubmittedAt || !check.reviewSubmittedBy) {
        throw new ActionError(
          'Die dokumentierte Übergabe zur Berufsträger-Prüfung fehlt. Bitte den Entwurf erneut ausdrücklich zur Freigabe einreichen.',
        );
      }
      const currentReviewSnapshotHash = gwgProfessionalReviewSnapshotHash(check);
      if (currentReviewSnapshotHash !== reviewSnapshotHash) {
        throw new ActionError(
          'Der angezeigte GwG-Snapshot ist nicht mehr aktuell. Bitte Seite neu laden und alle Angaben erneut prüfen.',
        );
      }
      const decisionErrors = gwgDecisionGateErrors(
        {
          ...check,
          checkId,
          clientId,
          clientKind: check.client.kind,
        },
        DEFAULT_FACTORS.map((factor) => factor.key),
      );
      if (decisionErrors.length > 0) throw new ActionError(decisionErrors.join(' '));
      if (check.riskLevel === null) throw new ActionError('Risikobewertung fehlt.');

      const validForDays = riskValidForDays(check.riskLevel);
      const validUntil = new Date(Date.now() + validForDays * 24 * 60 * 60 * 1000);

      // TOCTOU-Schutz: nur aus dem Prüfstatus heraus verifizieren. Verhindert,
      // dass ein bereits REJECTED-Check ohne Neubewertung auf VERIFIED flippt
      // bzw. eine parallele Reject-Entscheidung überschrieben wird.
      const claim = await tx.gwgCheck.updateMany({
        where: { id: checkId, clientId, status: 'IN_REVIEW' },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedBy: staffId,
          validUntil,
          reviewSubmittedAt: check.reviewSubmittedAt,
          reviewSubmittedBy: check.reviewSubmittedBy,
        },
      });
      if (claim.count === 0) {
        throw new ActionError('GwG-Check ist nicht mehr im Prüfstatus — bitte Seite neu laden.');
      }
      // Die Freigabeanforderung ist mit der Entscheidung für alle zuständigen
      // Berufsträger erledigt. Im selben Commit schließen, damit Badge und
      // Dropdown keinen bereits verifizierten Check weiter als offen zeigen.
      await markGwgReviewNotificationsReadTx(tx, { tenantId, checkId });
      verifiedValidUntil = validUntil.toISOString();
      await cancelOpenGwgInvitesTx(tx, {
        tenantId,
        clientId,
        cancelledByStaff: staffId,
      });

      // Mandant scharf schalten — der Trigger erlaubt das jetzt
      await tx.client.update({
        where: { id: clientId },
        data: { allowActive: true },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.verify',
        resourceType: 'gwg_check',
        resourceId: checkId,
        after: {
          riskLevel: check.riskLevel,
          riskScore: check.riskScore,
          validUntil: validUntil.toISOString(),
          professionalAttestation: true,
          reviewSnapshotHash: currentReviewSnapshotHash,
          reviewSubmittedAt: check.reviewSubmittedAt?.toISOString() ?? null,
          reviewSubmittedBy: check.reviewSubmittedBy,
        },
      });
    });
  } catch (e) {
    return toActionError(e);
  }

  // Begrüßungs-Mail an alle Mandanten-Kontakte mit Mail-Opt-in (nach Commit).
  // Befund 3: fire-and-forget mit catch+Log statt `void` (unhandled rejection).
  fireAndForget(
    'notifyClientContacts (gwg-activated)',
    notifyClientContacts({
      tenantId,
      clientId,
      slug: 'gwg-activated',
      vars: {
        portalUrl: `${portalBaseUrl}/portal/dashboard`,
      },
      fallback: {
        subject: 'Willkommen — Ihre Mandantschaft ist nun aktiv',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nIhre Mandantschaft ist jetzt vollständig eingerichtet. Loggen Sie sich gerne in Ihr Mandantenportal ein:\n\n{{portalUrl}}',
      },
    }),
  );
  if (verifiedValidUntil) {
    // Awaited (Guardrail: Outbox-Write muss dauerhaft sein, bevor die Action
    // zurückkehrt). Der früher unbegrenzt hängende Redis-Queue-Handoff ist in
    // der Outbox selbst per Timeout gedeckelt — siehe server/n8n/outbox.ts.
    await emitN8nEvent(
      'gwg.verified',
      { tenantId, clientId, gwgCheckId: checkId, validUntil: verifiedValidUntil },
      { tenantId },
    );
  }
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
  const { tenantId, staffId, ctx, session } = g;

  const parsed = parseFormData(RejectSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Begründung erforderlich.' };
  const { checkId, clientId, reason } = parsed.data;

  let contactIds: string[] = [];
  try {
    await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, clientId);
      const isBerufstraeger = await tx.clientResponsibility.findFirst({
        where: {
          clientId,
          staffId,
          role: 'BERUFSTRAEGER',
          staff: { tenantId, active: true, roles: { some: {} } },
        },
        select: { id: true },
      });
      if (!isBerufstraeger) {
        throw new ActionError(
          'Nur der für diesen Mandanten zugeordnete Berufsträger darf die GwG-Prüfung ablehnen.',
        );
      }
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
      await assertLatestCheckForDecision(tx, { clientId, checkId });
      // TOCTOU-Schutz: ein bereits verifizierter Check darf nicht per Race
      // nachträglich abgelehnt werden (sonst allowActive=true trotz Reject).
      const claim = await tx.gwgCheck.updateMany({
        where: { id: checkId, clientId, status: 'IN_REVIEW' },
        data: { status: 'REJECTED', rejectedReason: reason },
      });
      if (claim.count === 0) {
        throw new ActionError('GwG-Check ist nicht mehr zur Entscheidung eingereicht.');
      }
      await markGwgReviewNotificationsReadTx(tx, { tenantId, checkId });
      await cancelOpenGwgInvitesTx(tx, {
        tenantId,
        clientId,
        cancelledByStaff: staffId,
      });
      await tx.client.updateMany({
        where: { id: clientId, allowActive: true },
        data: { allowActive: false },
      });
      contactIds = (
        await tx.clientContact.findMany({
          where: { clientId, active: true },
          select: { id: true },
        })
      ).map((c) => c.id);
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.reject',
        resourceType: 'gwg_check',
        resourceId: checkId,
        after: { reason },
      });
    });
  } catch (e) {
    return toActionError(e);
  }

  // GwG-Schranke (§ 11 GwG): bestehende Portal-Sessions aller Kontakte des
  // Mandanten sofort beenden — sonst bliebe ein bereits eingeloggter Kontakt
  // bis zum JWT-Ablauf (24 h) handlungsfähig. Nach dem Commit (Redis ist
  // nicht transaktional); fail-open analog revocation.ts, der Session-
  // Callback in portal.ts prüft allowActive zusätzlich pro Request.
  for (const contactId of contactIds) {
    await revokeAllSessions('portal', contactId);
  }

  await emitN8nEvent('gwg.expired', { tenantId, clientId, reason: 'rejected' }, { tenantId });
  revalidatePath(`/staff/clients/${clientId}`);
  return { ok: true };
}
