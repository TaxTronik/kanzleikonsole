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
import { gwgVerificationErrors } from '@/server/gwg/verification';
import { lockGwgCheckLifecycleTx, startFreshGwgReviewTx } from '@/server/gwg/reverification';
import { notifyMany } from '@/server/notifications/service';
import {
  identityAssignmentForSubject,
  resolveIdentitySubject,
  type IdentitySubjectSource,
} from '@/server/gwg/identity-subject';
import {
  findCleanGwgEvidenceDocumentsTx,
  lockCleanGwgEvidenceDocumentsTx,
} from '@/server/gwg/evidence-documents';
import {
  gwgBeneficialOwnerRevision,
  gwgIdentityDocumentSetRevision,
  gwgLegalEntityRevision,
  gwgRiskRevision,
} from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';
import { cancelOpenGwgInvitesTx } from '@/server/gwg-onboarding/invite-lifecycle';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

// Einheitliches Action-Ergebnis aus der zentralen Quelle — der bestehende
// Import-Pfad './actions' bleibt für die Form-Komponenten stabil.
export type ActionResult = BaseActionResult;

// #2 (GwG-Integrität): Nach Abschluss einer Prüfung sind ihre Substanzdaten
// (Risikoantworten, wirtschaftlich Berechtigte, Ausweisdokumente) unveränderlich
// — § 8 GwG verlangt die unveränderte Aufbewahrung der Aufzeichnungen. Nur
// DRAFT/IN_REVIEW sind editierbar; eine Aktualisierung erfolgt über eine neue
// Prüfung (openCheckAction) bzw. den durch eine GwG-relevante Stammdaten-
// änderung ausgelösten Reset auf IN_REVIEW (clients/[id]/edit/actions.ts).
const EDITABLE_GWG_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW'];
type EditableGwgStatus = 'DRAFT' | 'IN_REVIEW';

const PERSONAL_ID_TYPES = ['PERSONALAUSWEIS', 'REISEPASS'] as const;

function isPersonalIdType(type: string): type is (typeof PERSONAL_ID_TYPES)[number] {
  return (PERSONAL_ID_TYPES as readonly string[]).includes(type);
}

export interface InvalidatedIdentitySet {
  documentSetId: string;
  revision: string;
}

export interface SavedBeneficialOwner {
  id: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct: string;
  isPep: boolean;
}

/**
 * Liefert nach einer Personenmutation die neuen Revisionswerte der betroffenen
 * Ausweissaetze. Damit kann das UI die serverseitige Entbestaetigung sofort
 * abbilden und beim naechsten Speichern die korrekte CAS-Revision mitsenden,
 * ohne einen kompletten Seiten-Reload zu erzwingen.
 */
async function invalidatedIdentitySetRevisions(
  tx: TxClient,
  checkId: string,
  affectedDocumentSetIds: string[],
): Promise<InvalidatedIdentitySet[]> {
  const documentSetIds = [...new Set(affectedDocumentSetIds)];
  if (documentSetIds.length === 0) return [];
  const documents = await tx.gwgIdDocument.findMany({
    where: { gwgCheckId: checkId, documentSetId: { in: documentSetIds } },
    select: {
      id: true,
      gwgCheckId: true,
      documentSetId: true,
      documentId: true,
      type: true,
      ownerName: true,
      number: true,
      issuedBy: true,
      issueDate: true,
      expiryDate: true,
      verifiedAt: true,
      naturalClientSubjectId: true,
      beneficialOwnerSubjectId: true,
      representativeSubjectId: true,
      identityAssignmentConfirmedAt: true,
      identityAssignmentConfirmedBy: true,
    },
  });
  return documentSetIds.map((documentSetId) => ({
    documentSetId,
    revision: gwgIdentityDocumentSetRevision(
      documents.filter((document) => document.documentSetId === documentSetId),
    ),
  }));
}

function assertGwgEditable(status: string): asserts status is EditableGwgStatus {
  if (!EDITABLE_GWG_STATUSES.includes(status)) {
    throw new ActionError(
      'Diese GwG-Prüfung ist bereits abgeschlossen (verifiziert/abgelehnt/abgelaufen) und darf nicht mehr geändert werden (§ 8 GwG). Für eine Aktualisierung bitte eine neue Prüfung anlegen.',
    );
  }
}

async function claimCheckMutation(
  tx: TxClient,
  input: {
    checkId: string;
    clientId: string;
    expectedStatus: EditableGwgStatus;
    invalidateRisk?: boolean;
  },
): Promise<void> {
  const claim = await tx.gwgCheck.updateMany({
    where: {
      id: input.checkId,
      clientId: input.clientId,
      status: input.expectedStatus,
    },
    data: {
      status: 'DRAFT',
      reviewSubmittedAt: null,
      reviewSubmittedBy: null,
      ...(input.invalidateRisk
        ? {
            riskLevel: null,
            riskScore: null,
            riskAnswers: Prisma.DbNull,
            riskBreakdown: Prisma.DbNull,
          }
        : {}),
    },
  });
  if (claim.count === 0) {
    throw new ActionError(
      'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.',
    );
  }
}

/** CAS-Prüfung für echte No-op-Saves, ohne eine laufende Freigabe zurückzusetzen. */
async function confirmUnchangedCheck(
  tx: TxClient,
  input: { checkId: string; clientId: string; expectedStatus: EditableGwgStatus },
): Promise<void> {
  const current = await tx.gwgCheck.findFirst({
    where: { id: input.checkId, clientId: input.clientId, status: input.expectedStatus },
    select: { id: true },
  });
  if (!current) {
    throw new ActionError(
      'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.',
    );
  }
}

/**
 * Defense in Depth für Bestandsdaten, die bereits vor der Terminalisierung
 * älterer Reviews mehrere offene Checks enthalten konnten. Entscheidungen
 * sind ausschließlich am neuesten Snapshot des Mandanten zulässig.
 */
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
        include: {
          beneficialOwners: true,
          representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
          idDocuments: {
            include: {
              document: {
                select: {
                  id: true,
                  tenantId: true,
                  clientId: true,
                  classification: true,
                  deletedAt: true,
                  gwgDestructionRequestedAt: true,
                  gwgDestroyedAt: true,
                },
              },
            },
          },
        },
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

      // Ein vernichteter Alt-Snapshot darf niemals wieder materialisiert
      // werden. Der gemeinsame Lifecycle-Lock serialisiert Check-Vernichtung
      // und Neustart; diese Prüfung schützt zusätzlich bereits vernichtete
      // Bestandsdaten.
      const snapshotSource = latest && latest.destroyedAt === null ? latest : null;
      const ownersToCopy = snapshotSource?.beneficialOwners ?? [];
      const copiedOwnerIds = new Map(ownersToCopy.map((owner) => [owner.id, randomUUID()]));
      const copiedDocumentSetIds = new Map<string, string>();
      const documentsToCopy =
        snapshotSource?.idDocuments.map((document) => {
          const evidence = document.document;
          const reusableDocumentId =
            evidence &&
            evidence.id === document.documentId &&
            evidence.tenantId === tenantId &&
            evidence.clientId === clientId &&
            evidence.classification === 'GWG_EVIDENCE' &&
            evidence.deletedAt === null &&
            evidence.gwgDestructionRequestedAt === null &&
            evidence.gwgDestroyedAt === null
              ? evidence.id
              : null;
          let copiedDocumentSetId = copiedDocumentSetIds.get(document.documentSetId);
          if (!copiedDocumentSetId) {
            copiedDocumentSetId = randomUUID();
            copiedDocumentSetIds.set(document.documentSetId, copiedDocumentSetId);
          }
          return {
            gwgCheckId: checkId,
            type: document.type,
            ownerName: document.ownerName,
            documentId: reusableDocumentId,
            number: document.number,
            issuedBy: document.issuedBy,
            issueDate: document.issueDate,
            expiryDate: document.expiryDate,
            // Sets sind absichtlich check-lokal. Vorder-/Rückseite behalten
            // innerhalb des neuen Checks dieselbe Gruppe, die UUID des
            // unveränderlichen Altchecks wird aber niemals wiederverwendet.
            documentSetId: copiedDocumentSetId,
            notes: document.notes,
          };
        }) ?? [];

      // Terminale Pflichtaufzeichnungen bleiben unverändert. Für die
      // Korrektur kopieren wir nur die Identifizierungsgrundlage in den neuen
      // Entwurf. Die Risikoanalyse wird bewusst nicht übernommen und muss für
      // den neuen Prüfzeitpunkt erneut bewertet werden.
      if (snapshotSource) {
        await tx.gwgCheck.update({
          where: { id: checkId },
          data: {
            notes: snapshotSource.notes,
            legalForm: snapshotSource.legalForm,
            registerNumber: snapshotSource.registerNumber,
            registerAuthority: snapshotSource.registerAuthority,
            noRegisterEntry: snapshotSource.noRegisterEntry,
            representativeNames: snapshotSource.representativeNames,
            ownershipStructureNotes: snapshotSource.ownershipStructureNotes,
          },
        });
        if (ownersToCopy.length > 0) {
          await tx.gwgBeneficialOwner.createMany({
            data: ownersToCopy.map((owner) => ({
              id: copiedOwnerIds.get(owner.id),
              gwgCheckId: checkId,
              fullName: owner.fullName,
              birthDate: owner.birthDate,
              birthPlace: owner.birthPlace,
              residence: owner.residence,
              nationality: owner.nationality,
              ownershipPct: owner.ownershipPct,
              isPep: owner.isPep,
              notes: owner.notes,
            })),
          });
        }
        if (snapshotSource.representatives.length > 0) {
          await tx.gwgRepresentative.createMany({
            data: snapshotSource.representatives.map((representative) => ({
              gwgCheckId: checkId,
              fullName: representative.fullName,
              position: representative.position,
              linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId
                ? (copiedOwnerIds.get(representative.linkedBeneficialOwnerId) ?? null)
                : null,
            })),
          });
        }
        if (documentsToCopy.length > 0) {
          await tx.gwgIdDocument.createMany({
            data: documentsToCopy,
          });
        }
      }

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
          copiedOwnerCount: ownersToCopy.length,
          copiedDocumentCount: documentsToCopy.length,
          copiedLinkedDocumentCount: documentsToCopy.filter(
            (document) => document.documentId !== null,
          ).length,
          invalidatedChecks: review.invalidatedChecks,
          clientDeactivated: review.clientDeactivated,
          changeScope: latest ? changeScope : 'INITIAL',
        },
      });
      return { checkId };
    },
    {
      revalidate: [
        `/staff/clients/${clientId}`,
        `/staff/clients/${clientId}/gwg`,
        `/staff/clients/onboarding/${clientId}`,
      ],
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
    const before = await tx.gwgCheck.findFirst({ where: { id: checkId, clientId } });
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
    let invalidatedIdentityDocuments = 0;
    let invalidatedIdentityDocumentSetIds: string[] = [];
    if (representativesChanged) {
      const submittedById = new Map(
        submittedRepresentatives.map((representative) => [representative.id, representative]),
      );
      const changedIdentityIds = check.representatives
        .filter((representative) => {
          const submitted = submittedById.get(representative.id);
          return (
            !submitted ||
            submitted.fullName !== representative.fullName ||
            submitted.linkedBeneficialOwnerId !== (representative.linkedBeneficialOwnerId ?? null)
          );
        })
        .map((representative) => representative.id);
      if (changedIdentityIds.length > 0) {
        const assignedDocuments = await tx.gwgIdDocument.findMany({
          where: {
            gwgCheckId: data.checkId,
            representativeSubjectId: { in: changedIdentityIds },
          },
          select: { id: true, documentSetId: true },
        });
        const invalidated = await tx.gwgIdDocument.updateMany({
          where: {
            gwgCheckId: data.checkId,
            id: { in: assignedDocuments.map((document) => document.id) },
          },
          data: {
            representativeSubjectId: null,
            identityAssignmentConfirmedAt: null,
            identityAssignmentConfirmedBy: null,
            verifiedAt: null,
          },
        });
        invalidatedIdentityDocuments = invalidated.count;
        invalidatedIdentityDocumentSetIds = assignedDocuments.map(
          (document) => document.documentSetId,
        );
      }
      const retainedIds = submittedRepresentatives
        .filter((representative) => !representative.isNew)
        .map((representative) => representative.id);
      const removedIds = check.representatives
        .filter((representative) => !retainedIds.includes(representative.id))
        .map((representative) => representative.id);
      if (removedIds.length > 0) {
        await tx.gwgRepresentative.deleteMany({
          where: { gwgCheckId: data.checkId, id: { in: removedIds } },
        });
      }
      const retainedWithChangedPosition = submittedRepresentatives.filter(
        (representative) =>
          !representative.isNew &&
          currentById.get(representative.id)?.position !== representative.position,
      );
      if (retainedWithChangedPosition.length > 0) {
        // Positionen zunächst aus dem eindeutigen Zielbereich schieben, damit
        // auch Vertauschen zweier Personen ohne Unique-Konflikt möglich ist.
        await tx.gwgRepresentative.updateMany({
          where: { gwgCheckId: data.checkId, id: { in: retainedIds } },
          data: { position: { increment: 10_000 } },
        });
      }
      const retainedToUpdate = submittedRepresentatives.filter((entry) => {
        const current = currentById.get(entry.id);
        return (
          !entry.isNew &&
          (retainedWithChangedPosition.length > 0 ||
            current?.fullName !== entry.fullName ||
            (current?.linkedBeneficialOwnerId ?? null) !== entry.linkedBeneficialOwnerId)
        );
      });
      if (retainedToUpdate.length > 0) {
        const changedOwnerLinkIds = retainedToUpdate
          .filter(
            (representative) =>
              (currentById.get(representative.id)?.linkedBeneficialOwnerId ?? null) !==
              representative.linkedBeneficialOwnerId,
          )
          .map((representative) => representative.id);
        if (changedOwnerLinkIds.length > 0) {
          // Der Unique-Index auf (check, linked owner) ist absichtlich nicht
          // deferrable. Link-Swaps werden deshalb zweiphasig NULL → Ziel
          // geschrieben, damit kein transienter Doppel-Link entsteht.
          await tx.gwgRepresentative.updateMany({
            where: { gwgCheckId: data.checkId, id: { in: changedOwnerLinkIds } },
            data: { linkedBeneficialOwnerId: null },
          });
        }
        await tx.$executeRaw(
          Prisma.sql`
            UPDATE "gwg_representative" AS representative
               SET "full_name" = changed.full_name,
                   "position" = changed.position,
                   "linked_beneficial_owner_id" = changed.linked_beneficial_owner_id,
                   "updated_at" = CURRENT_TIMESTAMP
              FROM (
                VALUES ${Prisma.join(
                  retainedToUpdate.map(
                    (representative) =>
                      Prisma.sql`(${representative.id}::uuid, ${representative.fullName}::text, ${representative.position}::integer, ${representative.linkedBeneficialOwnerId}::uuid)`,
                  ),
                )}
              ) AS changed(id, full_name, position, linked_beneficial_owner_id)
             WHERE representative."id" = changed.id
               AND representative."gwg_check_id" = ${data.checkId}::uuid
          `,
        );
      }
      const newRepresentatives = submittedRepresentatives.filter((entry) => entry.isNew);
      if (newRepresentatives.length > 0) {
        await tx.gwgRepresentative.createMany({
          data: newRepresentatives.map((representative) => ({
            id: representative.id,
            gwgCheckId: data.checkId,
            fullName: representative.fullName,
            position: representative.position,
            linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId,
          })),
        });
      }
    }
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

const AddOwnerSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.string().date(),
  birthPlace: z.string().trim().min(1).max(200),
  residence: z.string().trim().min(1).max(500),
  nationality: z.string().trim().min(1).max(100),
  ownershipPct: z.coerce.number().min(0).max(100).optional(),
  isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

export async function addBeneficialOwnerAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const parsed = AddOwnerSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep'),
  });
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
      // Check laden + Status prüfen. Das Scope {id, clientId} bindet die checkId
      // an den autorisierten Mandanten (kein Cross-Check-Write über fremde ID).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
        invalidateRisk: true,
      });
      const owner = await tx.gwgBeneficialOwner.create({
        data: {
          gwgCheckId: data.checkId,
          fullName: data.fullName,
          birthDate: data.birthDate ? new Date(data.birthDate) : null,
          birthPlace: data.birthPlace || null,
          residence: data.residence || null,
          nationality: data.nationality || null,
          ownershipPct: data.ownershipPct ?? null,
          isPep: data.isPep,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.owner.add',
        resourceType: 'gwg_beneficial_owner',
        resourceId: owner.id,
        after: {
          fullName: data.fullName,
          ownershipPct: data.ownershipPct ?? null,
          isPep: data.isPep,
        },
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
}

const UpdateOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.string().date(),
  birthPlace: z.string().trim().min(1).max(200),
  residence: z.string().trim().min(1).max(500),
  nationality: z.string().trim().min(1).max(100),
  ownershipPct: z.coerce.number().min(0).max(100).optional(),
  isPep: z.enum(['true', 'false']).transform((value) => value === 'true'),
  expectedRevision: z.string().min(2).max(20_000),
});

/**
 * Korrigiert die Angaben eines vorhandenen wirtschaftlich Berechtigten. Die
 * Check-Zeile wird zuerst per Status-CAS beansprucht; eine zeitgleiche Freigabe
 * gewinnt damit entweder vollstaendig oder wird sauber mit einem Konflikt
 * abgewiesen. Jede inhaltliche Korrektur nimmt eine laufende Freigabe zurueck.
 */
export async function updateBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    revision?: string;
    saved?: SavedBeneficialOwner;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = UpdateOwnerSchema.safeParse({
    ownerId: formData.get('ownerId'),
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    birthDate: formData.get('birthDate') ?? '',
    birthPlace: formData.get('birthPlace') ?? '',
    residence: formData.get('residence') ?? '',
    nationality: formData.get('nationality') ?? '',
    ownershipPct: formData.get('ownershipPct') || undefined,
    isPep: formData.get('isPep'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        beneficialOwners: {
          where: { id: data.ownerId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            ownershipPct: true,
            isPep: true,
          },
        },
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    const owner = check.beneficialOwners[0];
    if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
    assertGwgEditable(check.status);
    if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
      throw new ActionError(
        'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    const identityFieldsChanged =
      owner.fullName !== data.fullName ||
      owner.birthDate?.toISOString().slice(0, 10) !== data.birthDate ||
      (owner.birthPlace ?? '') !== data.birthPlace ||
      (owner.residence ?? '') !== data.residence ||
      (owner.nationality ?? '') !== data.nationality;
    const ownershipBefore = owner.ownershipPct === null ? null : Number(owner.ownershipPct);
    const ownershipAfter = data.ownershipPct ?? null;
    const contentChanged =
      identityFieldsChanged || ownershipBefore !== ownershipAfter || owner.isPep !== data.isPep;

    if (!contentChanged) {
      await confirmUnchangedCheck(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      return {
        reviewReset: false,
        revision: gwgBeneficialOwnerRevision(owner),
        saved: {
          id: data.ownerId,
          fullName: data.fullName,
          birthDate: data.birthDate,
          birthPlace: data.birthPlace,
          residence: data.residence,
          nationality: data.nationality,
          ownershipPct: data.ownershipPct === undefined ? '' : String(data.ownershipPct),
          isPep: data.isPep,
        },
      };
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const linkedRepresentatives = (check.representatives ?? []).filter(
      (representative) => representative.linkedBeneficialOwnerId === data.ownerId,
    );
    if (owner.fullName !== data.fullName && linkedRepresentatives.length > 0) {
      await tx.gwgRepresentative.updateMany({
        where: {
          gwgCheckId: data.checkId,
          linkedBeneficialOwnerId: data.ownerId,
        },
        data: { fullName: data.fullName },
      });
      await tx.gwgCheck.update({
        where: { id: data.checkId },
        data: {
          representativeNames: check.representatives.map((representative) =>
            representative.linkedBeneficialOwnerId === data.ownerId
              ? data.fullName
              : representative.fullName,
          ),
        },
      });
    }
    let invalidatedIdentityDocuments = 0;
    let invalidatedIdentityDocumentSetIds: string[] = [];
    if (identityFieldsChanged) {
      const linkedRepresentativeIds = linkedRepresentatives.map(
        (representative) => representative.id,
      );
      const assignedDocuments = await tx.gwgIdDocument.findMany({
        where: {
          gwgCheckId: data.checkId,
          OR: [
            { beneficialOwnerSubjectId: data.ownerId },
            ...(linkedRepresentativeIds.length > 0
              ? [{ representativeSubjectId: { in: linkedRepresentativeIds } }]
              : []),
          ],
        },
        select: { id: true, documentSetId: true },
      });
      const invalidated = await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: assignedDocuments.map((document) => document.id) },
        },
        data: {
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
      invalidatedIdentityDocuments = invalidated.count;
      invalidatedIdentityDocumentSetIds = assignedDocuments.map(
        (document) => document.documentSetId,
      );
    }
    await tx.gwgBeneficialOwner.update({
      where: { id: data.ownerId },
      data: {
        fullName: data.fullName,
        birthDate: data.birthDate ? new Date(data.birthDate) : null,
        birthPlace: data.birthPlace || null,
        residence: data.residence || null,
        nationality: data.nationality || null,
        ownershipPct: data.ownershipPct ?? null,
        isPep: data.isPep,
      },
    });
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      invalidatedIdentityDocumentSetIds,
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.owner.update',
      resourceType: 'gwg_beneficial_owner',
      resourceId: data.ownerId,
      before: {
        fullName: owner.fullName,
        birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct?.toString() ?? null,
        isPep: owner.isPep,
      },
      after: {
        fullName: data.fullName,
        birthDate: data.birthDate || null,
        birthPlace: data.birthPlace || null,
        residence: data.residence || null,
        nationality: data.nationality || null,
        ownershipPct: data.ownershipPct ?? null,
        isPep: data.isPep,
        invalidatedIdentityDocuments,
      },
    });
    return {
      reviewReset: check.status === 'IN_REVIEW',
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
      revision: gwgBeneficialOwnerRevision({
        id: data.ownerId,
        fullName: data.fullName,
        birthDate: data.birthDate,
        birthPlace: data.birthPlace || null,
        residence: data.residence || null,
        nationality: data.nationality || null,
        ownershipPct: data.ownershipPct ?? null,
        isPep: data.isPep,
      }),
      saved: {
        id: data.ownerId,
        fullName: data.fullName,
        birthDate: data.birthDate,
        birthPlace: data.birthPlace,
        residence: data.residence,
        nationality: data.nationality,
        ownershipPct: data.ownershipPct === undefined ? '' : String(data.ownershipPct),
        isPep: data.isPep,
      },
    };
  });
}

const RemoveOwnerSchema = z.object({
  ownerId: z.string().uuid(),
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  expectedRevision: z.string().min(2).max(20_000),
});

/**
 * Entfernt eine nicht mehr wirtschaftlich berechtigte Person nur aus dem
 * aktuellen, bearbeitbaren Snapshot. Zugehörige Ausweisbelege bleiben in der
 * Akte erhalten, werden aber bewusst entbestätigt und müssen einer aktuellen
 * Person neu zugeordnet werden. Der alte VERIFIED-Snapshot bleibt unverändert.
 */
export async function removeBeneficialOwnerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    removedOwnerId?: string;
    reviewReset?: boolean;
    invalidatedIdentitySets?: InvalidatedIdentitySet[];
  }
> {
  const parsed = RemoveOwnerSchema.safeParse({
    ownerId: formData.get('ownerId'),
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        representatives: {
          where: { linkedBeneficialOwnerId: data.ownerId },
          select: { id: true },
        },
        beneficialOwners: {
          where: { id: data.ownerId },
          select: {
            id: true,
            fullName: true,
            birthDate: true,
            birthPlace: true,
            residence: true,
            nationality: true,
            ownershipPct: true,
            isPep: true,
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(check.status);
    const owner = check.beneficialOwners[0];
    if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
    if (gwgBeneficialOwnerRevision(owner) !== data.expectedRevision) {
      throw new ActionError(
        'Die Personendaten wurden zwischenzeitlich geändert. Bitte Seite neu laden.',
      );
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
      invalidateRisk: true,
    });
    const linkedRepresentativeIds = check.representatives.map(
      (representative) => representative.id,
    );
    const affectedDocuments = await tx.gwgIdDocument.findMany({
      where: {
        gwgCheckId: data.checkId,
        OR: [
          { beneficialOwnerSubjectId: data.ownerId },
          ...(linkedRepresentativeIds.length > 0
            ? [{ representativeSubjectId: { in: linkedRepresentativeIds } }]
            : []),
        ],
      },
      select: {
        id: true,
        documentSetId: true,
        beneficialOwnerSubjectId: true,
      },
    });
    const directlyAssignedDocumentIds = affectedDocuments
      .filter((document) => document.beneficialOwnerSubjectId === data.ownerId)
      .map((document) => document.id);
    if (directlyAssignedDocumentIds.length > 0) {
      await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: directlyAssignedDocumentIds },
        },
        data: {
          beneficialOwnerSubjectId: null,
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      });
    }
    const unlinkedRepresentativeRoles = await tx.gwgRepresentative.updateMany({
      where: {
        gwgCheckId: data.checkId,
        linkedBeneficialOwnerId: data.ownerId,
      },
      data: { linkedBeneficialOwnerId: null },
    });
    const removed = await tx.gwgBeneficialOwner.deleteMany({
      where: { id: data.ownerId, gwgCheckId: data.checkId },
    });
    if (removed.count !== 1) {
      throw new ActionError('Die Person wurde parallel geändert. Bitte Seite neu laden.');
    }
    const invalidatedIdentitySets = await invalidatedIdentitySetRevisions(
      tx,
      data.checkId,
      affectedDocuments.map((document) => document.documentSetId),
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.owner.remove',
      resourceType: 'gwg_beneficial_owner',
      resourceId: data.ownerId,
      before: {
        fullName: owner.fullName,
        birthDate: owner.birthDate?.toISOString().slice(0, 10) ?? null,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct?.toString() ?? null,
        isPep: owner.isPep,
      },
      after: {
        removedFromCurrentSnapshot: true,
        invalidatedIdentityDocuments: affectedDocuments.length,
        unlinkedRepresentativeRoles: unlinkedRepresentativeRoles.count,
      },
    });
    return {
      removedOwnerId: data.ownerId,
      reviewReset: check.status === 'IN_REVIEW',
      ...(invalidatedIdentitySets.length > 0 ? { invalidatedIdentitySets } : {}),
    };
  });
}

const AddIdDocSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    type: z.enum([
      'PERSONALAUSWEIS',
      'REISEPASS',
      'HANDELSREGISTERAUSZUG',
      'GESELLSCHAFTSVERTRAG',
      'VOLLMACHT',
      'TRANSPARENZREGISTER_AUSZUG',
      'SONSTIGES',
    ]),
    subjectKey: z.string().max(500).optional().or(z.literal('')),
    number: z.string().max(100).optional().or(z.literal('')),
    issuedBy: z.string().max(200).optional().or(z.literal('')),
    issueDate: z.string().date().optional().or(z.literal('')),
    expiryDate: z.string().date().optional().or(z.literal('')),
    documentIds: z
      .array(z.string().uuid())
      .min(1, 'Mindestens ein Aktenbeleg ist erforderlich.')
      .max(4, 'Ein Ausweissatz darf höchstens vier Dateien enthalten.'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Jeder Aktenbeleg darf im Satz nur einmal vorkommen.',
      });
    }
    if (!isPersonalIdType(value.type) && value.documentIds.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Ein Rechtsträgernachweis besteht aus genau einem Aktenbeleg.',
      });
    }
    if (isPersonalIdType(value.type) && !value.subjectKey?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectKey'],
        message: 'Identifizierte Person ist erforderlich.',
      });
    }
  });

const SearchGwgDocumentsSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  query: z.string().trim().min(2).max(100),
});

export interface GwgDocumentSearchResult {
  id: string;
  title: string;
  createdAt: string;
}

/**
 * Durchsucht die gesamte Mandantenakte serverseitig. Die initiale Seite lädt
 * bewusst nur die jüngsten Belege; ältere Treffer bleiben über diese Suche
 * erreichbar. Bereits in diesem Check verknüpfte Dateien werden hier nicht
 * erneut angeboten (Alt-Sätze stellt die Review-Karte separat zum Merge dar).
 */
export async function searchUnlinkedGwgDocumentsAction(input: {
  checkId: string;
  clientId: string;
  query: string;
}): Promise<
  ActionResult & {
    documents?: GwgDocumentSearchResult[];
    limited?: boolean;
  }
> {
  const parsed = SearchGwgDocumentsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Bitte mindestens zwei Zeichen eingeben.' };
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: { id: true },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');

    const matches = await findCleanGwgEvidenceDocumentsTx(tx, {
      tenantId,
      clientId: data.clientId,
      query: data.query,
      excludeLinkedCheckId: data.checkId,
      limit: 51,
    });
    return {
      documents: matches.slice(0, 50).map((document) => ({
        id: document.id,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
      })),
      limited: matches.length > 50,
    };
  });
}

function isDateOnOrAfterToday(value: string, now: Date = new Date()): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Number.isFinite(date.getTime()) && date.getTime() >= today;
}

export async function addIdDocumentAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const selectedDocumentIds = formData
    .getAll('documentIds')
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (selectedDocumentIds.length === 0) {
    const legacyDocumentId = formData.get('documentId');
    if (typeof legacyDocumentId === 'string' && legacyDocumentId) {
      selectedDocumentIds.push(legacyDocumentId);
    }
  }
  const parsed = AddIdDocSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    type: formData.get('type'),
    subjectKey: formData.get('subjectKey') ?? '',
    number: formData.get('number') ?? '',
    issuedBy: formData.get('issuedBy') ?? '',
    issueDate: formData.get('issueDate') ?? '',
    expiryDate: formData.get('expiryDate') ?? '',
    documentIds: selectedDocumentIds,
  });
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
      // Check laden + Status prüfen (bindet checkId an den autorisierten Mandanten).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: {
          status: true,
          client: { select: { id: true, name: true, kind: true } },
          representatives: {
            select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          },
          beneficialOwners: {
            select: { id: true, fullName: true, birthDate: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);

      const subjectSource: IdentitySubjectSource = {
        clientId: check.client.id,
        clientName: check.client.name,
        clientKind: check.client.kind,
        representatives: check.representatives,
        beneficialOwners: check.beneficialOwners,
      };
      const subject = isPersonalIdType(data.type)
        ? resolveIdentitySubject(subjectSource, data.subjectKey ?? '')
        : null;
      if (isPersonalIdType(data.type) && !subject) {
        throw new ActionError(
          'Die identifizierte Person gehört nicht mehr zu den erfassten Mandanten-, Vertretungs- oder Eigentümerdaten. Bitte Person neu auswählen.',
        );
      }

      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      if (
        !(await lockCleanGwgEvidenceDocumentsTx(tx, {
          tenantId,
          clientId: data.clientId,
          documentIds: data.documentIds,
        }))
      ) {
        throw new ActionError(
          'Alle verknüpften Nachweise müssen verfügbare GwG-Belege mit vollständig geprüfter, sauberer Dateiversion desselben Mandanten sein.',
        );
      }

      const alreadyLinked = await tx.gwgIdDocument.findFirst({
        where: {
          gwgCheckId: data.checkId,
          documentId:
            data.documentIds.length === 1 ? data.documentIds[0] : { in: data.documentIds },
        },
        select: { id: true, type: true },
      });
      if (alreadyLinked) {
        throw new ActionError(
          'Dieser Aktenbeleg ist dieser GwG-Prüfung bereits zugeordnet. Bitte den vorhandenen Nachweis aufklappen und dort bearbeiten.',
        );
      }

      const assignmentConfirmedAt =
        isPersonalIdType(data.type) &&
        data.number?.trim() &&
        data.issuedBy?.trim() &&
        data.issueDate &&
        data.expiryDate &&
        isDateOnOrAfterToday(data.expiryDate)
          ? new Date()
          : null;
      const assignment = subject
        ? identityAssignmentForSubject(subject)
        : {
            naturalClientSubjectId: null,
            beneficialOwnerSubjectId: null,
            representativeSubjectId: null,
          };
      const documentSetId = randomUUID();
      const sharedData = {
        gwgCheckId: data.checkId,
        type: data.type,
        ownerName: isPersonalIdType(data.type) ? subject!.name : check.client.name,
        number: isPersonalIdType(data.type) ? data.number || null : null,
        issuedBy: isPersonalIdType(data.type) ? data.issuedBy || null : null,
        issueDate: isPersonalIdType(data.type) && data.issueDate ? new Date(data.issueDate) : null,
        expiryDate:
          isPersonalIdType(data.type) && data.expiryDate ? new Date(data.expiryDate) : null,
        documentSetId,
        ...assignment,
        identityAssignmentConfirmedAt: assignmentConfirmedAt,
        identityAssignmentConfirmedBy: assignmentConfirmedAt ? staffId : null,
        verifiedAt: assignmentConfirmedAt,
      };
      let resourceId: string = documentSetId;
      if (data.documentIds.length === 1) {
        const idDoc = await tx.gwgIdDocument.create({
          data: { ...sharedData, documentId: data.documentIds[0]! },
        });
        resourceId = idDoc.id;
      } else {
        await tx.gwgIdDocument.createMany({
          data: data.documentIds.map((documentId) => ({ ...sharedData, documentId })),
        });
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: isPersonalIdType(data.type) ? 'gwg.id_document.add' : 'gwg.evidence.add',
        resourceType: data.documentIds.length === 1 ? 'gwg_id_document' : 'gwg_id_document_set',
        resourceId,
        after: {
          type: data.type,
          ownerName: isPersonalIdType(data.type) ? subject!.name : null,
          subjectKey: isPersonalIdType(data.type) ? data.subjectKey : null,
          documentIds: data.documentIds,
          identityAssignmentConfirmedAt: assignmentConfirmedAt?.toISOString() ?? null,
          verifiedAt: assignmentConfirmedAt?.toISOString() ?? null,
        },
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
}

const ExtendIdentityDocumentSetSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    targetDocumentSetId: z.string().uuid(),
    documentIds: z
      .array(z.string().uuid())
      .min(1, 'Mindestens eine Datei ist erforderlich.')
      .max(4, 'Es können höchstens vier Dateien auf einmal ergänzt werden.'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.documentIds).size !== value.documentIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: 'Jede Datei darf nur einmal ausgewählt werden.',
      });
    }
  });

/**
 * Ergänzt einen bestehenden Ausweissatz direkt aus der Akte. Unverknüpfte
 * Dateien werden angelegt; ein anderer, noch unbestätigter Alt-Satz wird als
 * Ganzes verschoben. Jede strukturelle Änderung entwertet die bisherige
 * Bestätigung des Ziels, damit Vorder-/Rückseite anschließend gemeinsam erneut
 * geprüft werden müssen.
 */
export async function extendIdentityDocumentSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult & { reviewReset?: boolean }> {
  const documentIds = formData
    .getAll('documentIds')
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const parsed = ExtendIdentityDocumentSetSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    targetDocumentSetId: formData.get('targetDocumentSetId'),
    documentIds,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });

      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });

      const targetLockKey = `gwg-document-set:${data.targetDocumentSetId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${targetLockKey}, 0))`;

      // Erst nach Parent- und Set-Lock lesen. Dadurch basiert Kapazität,
      // Bestätigungsstatus und Quellsatz-Auflösung auf einem stabilen Zustand.
      const existingDocuments = await tx.gwgIdDocument.findMany({
        where: { gwgCheckId: data.checkId },
        select: {
          id: true,
          documentSetId: true,
          type: true,
          ownerName: true,
          documentId: true,
          number: true,
          issuedBy: true,
          issueDate: true,
          expiryDate: true,
          naturalClientSubjectId: true,
          beneficialOwnerSubjectId: true,
          representativeSubjectId: true,
          identityAssignmentConfirmedAt: true,
          identityAssignmentConfirmedBy: true,
          verifiedAt: true,
          document: {
            select: {
              tenantId: true,
              clientId: true,
              classification: true,
              deletedAt: true,
              gwgDestructionRequestedAt: true,
              gwgDestroyedAt: true,
            },
          },
        },
      });
      const targetDocuments = existingDocuments.filter(
        (entry) => entry.documentSetId === data.targetDocumentSetId,
      );
      if (
        targetDocuments.length === 0 ||
        targetDocuments.some((entry) => !isPersonalIdType(entry.type))
      ) {
        throw new ActionError(
          'Der Ziel-Ausweissatz ist nicht mehr vorhanden oder enthält keinen Personalausweis/Reisepass.',
        );
      }

      const selectedIds = new Set(data.documentIds);
      const selectedLinked = existingDocuments.filter(
        (entry) => entry.documentId !== null && selectedIds.has(entry.documentId),
      );
      if (selectedLinked.some((entry) => entry.documentSetId === data.targetDocumentSetId)) {
        throw new ActionError(
          'Mindestens eine ausgewählte Datei gehört bereits zum Ziel-Ausweissatz.',
        );
      }
      if (selectedLinked.some((entry) => !isPersonalIdType(entry.type))) {
        throw new ActionError(
          'Ein Rechtsträgernachweis kann nicht als Ausweisseite zusammengeführt werden.',
        );
      }

      const sourceSetIds = new Set(selectedLinked.map((entry) => entry.documentSetId));
      const sourceDocuments = existingDocuments.filter((entry) =>
        sourceSetIds.has(entry.documentSetId),
      );
      if (
        sourceDocuments.some(
          (entry) =>
            !isPersonalIdType(entry.type) ||
            entry.verifiedAt !== null ||
            entry.identityAssignmentConfirmedAt !== null ||
            entry.identityAssignmentConfirmedBy !== null,
        )
      ) {
        throw new ActionError(
          'Ein bereits bestätigter Ausweissatz kann nicht mit einem anderen Satz zusammengeführt werden.',
        );
      }

      const selectedLinkedIds = new Set(
        selectedLinked
          .map((entry) => entry.documentId)
          .filter((documentId): documentId is string => documentId !== null),
      );
      const unlinkedDocumentIds = data.documentIds.filter(
        (documentId) => !selectedLinkedIds.has(documentId),
      );
      const finalDocumentCount =
        targetDocuments.length + sourceDocuments.length + unlinkedDocumentIds.length;
      if (finalDocumentCount > 4) {
        throw new ActionError(
          `Der zusammengeführte Ausweissatz hätte ${finalDocumentCount} Dateien. Zulässig sind höchstens vier.`,
        );
      }

      const fullExistingSet = [...targetDocuments, ...sourceDocuments];
      const allDocumentIds = [
        ...fullExistingSet.map((entry) => entry.documentId),
        ...unlinkedDocumentIds,
      ];
      if (allDocumentIds.some((documentId) => documentId === null)) {
        throw new ActionError(
          'Der Ziel- oder Quellsatz enthält eine nicht mehr verfügbare Datei und kann nicht zusammengeführt werden.',
        );
      }
      const uniqueDocumentIds = [
        ...new Set(
          allDocumentIds.filter((documentId): documentId is string => documentId !== null),
        ),
      ].sort();
      if (
        !(await lockCleanGwgEvidenceDocumentsTx(tx, {
          tenantId,
          clientId: data.clientId,
          documentIds: uniqueDocumentIds,
        }))
      ) {
        throw new ActionError(
          'Alle Dateien des Ziel-/Quellsatzes und der Auswahl müssen verfügbare GwG-Belege mit vollständig geprüfter, sauberer Dateiversion desselben Mandanten sein.',
        );
      }

      const first = targetDocuments[0]!;
      const sharedData = {
        documentSetId: data.targetDocumentSetId,
        type: first.type,
        ownerName: first.ownerName,
        number: first.number,
        issuedBy: first.issuedBy,
        issueDate: first.issueDate,
        expiryDate: first.expiryDate,
        naturalClientSubjectId: first.naturalClientSubjectId,
        beneficialOwnerSubjectId: first.beneficialOwnerSubjectId,
        representativeSubjectId: first.representativeSubjectId,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        verifiedAt: null,
      };
      const rowsToNormalize = [...targetDocuments, ...sourceDocuments];
      const normalized = await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: rowsToNormalize.map((entry) => entry.id) },
          documentSetId: {
            in: [data.targetDocumentSetId, ...sourceSetIds],
          },
        },
        data: sharedData,
      });
      if (normalized.count !== rowsToNormalize.length) {
        throw new ActionError(
          'Ein Ausweissatz wurde parallel geändert. Bitte Seite neu laden und erneut versuchen.',
        );
      }
      if (unlinkedDocumentIds.length > 0) {
        await tx.gwgIdDocument.createMany({
          data: unlinkedDocumentIds.map((documentId) => ({
            gwgCheckId: data.checkId,
            documentId,
            ...sharedData,
            notes: 'Ausweissatz durch Kanzlei ergänzt',
          })),
        });
      }

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.id_document.set_files_update',
        resourceType: 'gwg_id_document_set',
        resourceId: data.targetDocumentSetId,
        before: {
          targetDocumentIds: targetDocuments.map((entry) => entry.documentId),
          sourceDocumentSetIds: [...sourceSetIds],
          targetWasConfirmed: targetDocuments.some(
            (entry) => entry.verifiedAt !== null || entry.identityAssignmentConfirmedAt !== null,
          ),
        },
        after: {
          documentIds: [
            ...targetDocuments.map((entry) => entry.documentId),
            ...sourceDocuments.map((entry) => entry.documentId),
            ...unlinkedDocumentIds,
          ],
          mergedDocumentSetIds: [...sourceSetIds],
          identityAssignmentRequiresConfirmation: true,
        },
      });
      return { reviewReset: check.status === 'IN_REVIEW' };
    },
    {
      revalidate: `/staff/clients/${data.clientId}/gwg`,
      uniqueError:
        'Mindestens eine Datei wurde zwischenzeitlich bereits zugeordnet. Bitte Seite neu laden.',
    },
  );
}

const UpdateIdDocumentsSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  documentSetId: z.string().uuid(),
  type: z.enum(['PERSONALAUSWEIS', 'REISEPASS']),
  subjectKey: z.string().min(1).max(500),
  number: z.string().trim().min(1).max(100),
  issuedBy: z.string().trim().min(1).max(200),
  issueDate: z.string().date(),
  expiryDate: z.string().date(),
  expectedRevision: z.string().min(2).max(50_000),
});

/**
 * Bestätigt oder korrigiert einen zusammengehörigen Ausweissatz (z. B.
 * Vorder- und Rückseite) in einem atomaren Schritt. Die Person kommt niemals
 * aus Freitext, sondern wird gegen den aktuellen GwG-Snapshot aufgelöst.
 */
export async function updateIdDocumentsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<
  ActionResult & {
    reviewReset?: boolean;
    saved?: {
      type: 'PERSONALAUSWEIS' | 'REISEPASS';
      subjectKey: string;
      ownerName: string;
      number: string;
      issuedBy: string;
      issueDate: string;
      expiryDate: string;
    };
    revision?: string;
  }
> {
  const parsed = UpdateIdDocumentsSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    documentSetId: formData.get('documentSetId'),
    type: formData.get('type'),
    subjectKey: formData.get('subjectKey'),
    number: formData.get('number'),
    issuedBy: formData.get('issuedBy'),
    issueDate: formData.get('issueDate') ?? '',
    expiryDate: formData.get('expiryDate'),
    expectedRevision: formData.get('expectedRevision'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join(' '),
    };
  }
  const data = parsed.data;

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, data.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: data.clientId });
    const check = await tx.gwgCheck.findFirst({
      where: { id: data.checkId, clientId: data.clientId },
      select: {
        status: true,
        client: { select: { id: true, name: true, kind: true } },
        representatives: {
          select: { id: true, fullName: true, position: true, linkedBeneficialOwnerId: true },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
        },
        beneficialOwners: {
          select: { id: true, fullName: true, birthDate: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        idDocuments: {
          where: { documentSetId: data.documentSetId },
          select: {
            id: true,
            gwgCheckId: true,
            documentId: true,
            type: true,
            ownerName: true,
            number: true,
            issuedBy: true,
            issueDate: true,
            expiryDate: true,
            verifiedAt: true,
            documentSetId: true,
            naturalClientSubjectId: true,
            beneficialOwnerSubjectId: true,
            representativeSubjectId: true,
            identityAssignmentConfirmedAt: true,
            identityAssignmentConfirmedBy: true,
            document: {
              select: {
                id: true,
                tenantId: true,
                clientId: true,
                classification: true,
                deletedAt: true,
                gwgDestructionRequestedAt: true,
                gwgDestroyedAt: true,
              },
            },
          },
        },
      },
    });
    if (!check) throw new ActionError('GwG-Check nicht gefunden.');
    assertGwgEditable(check.status);
    if (
      check.idDocuments.length === 0 ||
      check.idDocuments.some((document) => !isPersonalIdType(document.type))
    ) {
      throw new ActionError(
        'Der Ausweissatz ist unvollständig oder gehört nicht zu dieser GwG-Prüfung.',
      );
    }
    if (gwgIdentityDocumentSetRevision(check.idDocuments) !== data.expectedRevision) {
      throw new ActionError(
        'Der Ausweissatz wurde zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
      );
    }
    if (
      check.idDocuments.some(
        (entry) =>
          !entry.document ||
          entry.document.id === null ||
          entry.document.tenantId !== tenantId ||
          entry.document.clientId !== data.clientId ||
          entry.document.classification !== 'GWG_EVIDENCE' ||
          entry.document.deletedAt !== null ||
          entry.document.gwgDestructionRequestedAt !== null ||
          entry.document.gwgDestroyedAt !== null,
      )
    ) {
      throw new ActionError(
        'Mindestens eine Datei dieses Ausweissatzes ist nicht mehr als GwG-Nachweis verfügbar.',
      );
    }
    if (!isDateOnOrAfterToday(data.expiryDate)) {
      throw new ActionError(
        'Der Ausweis ist abgelaufen. Bitte ein gültiges Ablaufdatum oder einen neuen Ausweis erfassen.',
      );
    }

    const subject = resolveIdentitySubject(
      {
        clientId: check.client.id,
        clientName: check.client.name,
        clientKind: check.client.kind,
        representatives: check.representatives,
        beneficialOwners: check.beneficialOwners,
      },
      data.subjectKey,
    );
    if (!subject) {
      throw new ActionError(
        'Die identifizierte Person gehört nicht mehr zu den erfassten Mandanten-, Vertretungs- oder Eigentümerdaten. Bitte Person neu auswählen.',
      );
    }

    await claimCheckMutation(tx, {
      checkId: data.checkId,
      clientId: data.clientId,
      expectedStatus: check.status,
    });
    if (
      !(await lockCleanGwgEvidenceDocumentsTx(tx, {
        tenantId,
        clientId: data.clientId,
        documentIds: check.idDocuments.map((entry) => entry.document!.id),
      }))
    ) {
      throw new ActionError(
        'Mindestens eine Datei dieses Ausweissatzes besitzt keine vollständig geprüfte, saubere neueste Dateiversion.',
      );
    }
    const verifiedAt = new Date();
    const assignment = identityAssignmentForSubject(subject);
    const update = await tx.gwgIdDocument.updateMany({
      where: { documentSetId: data.documentSetId, gwgCheckId: data.checkId },
      data: {
        type: data.type,
        ownerName: subject.name,
        number: data.number,
        issuedBy: data.issuedBy,
        issueDate: new Date(data.issueDate),
        expiryDate: new Date(data.expiryDate),
        ...assignment,
        identityAssignmentConfirmedAt: verifiedAt,
        identityAssignmentConfirmedBy: staffId,
        verifiedAt,
      },
    });
    if (update.count !== check.idDocuments.length) {
      throw new ActionError(
        'Der Ausweissatz wurde parallel geändert. Bitte Seite neu laden und erneut prüfen.',
      );
    }
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.id_document.update',
      resourceType: 'gwg_id_document_set',
      resourceId: data.documentSetId,
      before: { documents: check.idDocuments },
      after: {
        documentSetId: data.documentSetId,
        documentIds: check.idDocuments.map((document) => document.id),
        type: data.type,
        ownerName: subject.name,
        subjectKey: data.subjectKey,
        number: data.number,
        issuedBy: data.issuedBy,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        verifiedAt: verifiedAt.toISOString(),
      },
    });
    return {
      reviewReset: check.status === 'IN_REVIEW',
      saved: {
        type: data.type,
        subjectKey: data.subjectKey,
        ownerName: subject.name,
        number: data.number,
        issuedBy: data.issuedBy,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
      },
      revision: gwgIdentityDocumentSetRevision(
        check.idDocuments.map((document) => ({
          ...document,
          type: data.type,
          ownerName: subject.name,
          number: data.number,
          issuedBy: data.issuedBy,
          issueDate: data.issueDate,
          expiryDate: data.expiryDate,
          ...assignment,
          identityAssignmentConfirmedAt: verifiedAt,
          identityAssignmentConfirmedBy: staffId,
          verifiedAt,
        })),
      ),
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
  const parsed = CheckDecisionSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler — ungültige IDs.' };
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
      if (check.riskScore === null || check.riskLevel === null) {
        throw new ActionError('Bitte zuerst die Risikobewertung vollständig speichern.');
      }
      const savedAnswers = (check.riskAnswers as Record<string, number> | null) ?? {};
      if (DEFAULT_FACTORS.some((factor) => savedAnswers[factor.key] === undefined)) {
        throw new ActionError(
          'Die Risikoanalyse ist unvollständig — bitte alle Faktoren bewerten.',
        );
      }

      const verificationErrors = gwgVerificationErrors({
        checkId,
        clientId,
        clientKind: check.client.kind,
        legalForm: check.legalForm,
        registerNumber: check.registerNumber,
        registerAuthority: check.registerAuthority,
        noRegisterEntry: check.noRegisterEntry,
        representativeNames: check.representativeNames,
        representatives: check.representatives,
        ownershipStructureNotes: check.ownershipStructureNotes,
        beneficialOwners: check.beneficialOwners,
        idDocuments: check.idDocuments,
      });
      if (verificationErrors.length > 0) {
        throw new ActionError(verificationErrors.join(' '));
      }
      if (check.beneficialOwners.some((owner) => owner.isPep) && savedAnswers['pep'] !== 3) {
        throw new ActionError(
          'PEP-Fall: Der PEP-Risikofaktor muss ausdrücklich als PEP bewertet werden.',
        );
      }
      if (check.beneficialOwners.some((owner) => owner.isPep) && check.riskLevel !== 'HIGH') {
        throw new ActionError('PEP-Fall: Die Risikobewertung muss vor der Freigabe HIGH ergeben.');
      }

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

  revalidatePath(`/staff/clients/${clientId}/gwg`);
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

  const parsed = VerifyDecisionSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    reviewSnapshotHash: formData.get('reviewSnapshotHash'),
    professionalAttestation: formData.get('professionalAttestation'),
  });
  if (!parsed.success) {
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
      if (check.riskScore === null || check.riskLevel === null) {
        throw new ActionError('Bitte zuerst Risikobewertung durchführen.');
      }
      // § 10 Abs. 2 GwG: Die Risikoanalyse muss VOLLSTÄNDIG sein. Fehlende
      // Faktoren zählen im Score als 0 und könnten eine unbewertete Prüfung als
      // LOW verschleiern — vor der Scharfschaltung muss jeder Faktor bewusst
      // bewertet sein (Defense-in-Depth zum Formular-Placeholder).
      const savedAnswers = (check.riskAnswers as Record<string, number> | null) ?? {};
      const unbewertet = DEFAULT_FACTORS.filter(
        (f) => savedAnswers[f.key] === undefined || savedAnswers[f.key] === null,
      );
      if (unbewertet.length > 0) {
        throw new ActionError(
          'Die Risikoanalyse ist unvollständig — bitte alle Risikofaktoren bewerten, bevor die Prüfung verifiziert wird (§ 10 Abs. 2 GwG).',
        );
      }
      if (check.idDocuments.length === 0) {
        throw new ActionError('Mindestens ein Identitätsdokument erforderlich.');
      }
      // H-2 / § 15 GwG: Ist ein wirtschaftlich Berechtigter als PEP markiert,
      // MUSS die Risikostufe HIGH sein (jährliche Überwachung). Bei
      // widersprechender Bewertung Verifikation blockieren — die erneute
      // Risikobewertung erzwingt über den PEP-Override HIGH.
      const verificationErrors = gwgVerificationErrors({
        checkId,
        clientId,
        clientKind: check.client.kind,
        legalForm: check.legalForm,
        registerNumber: check.registerNumber,
        registerAuthority: check.registerAuthority,
        noRegisterEntry: check.noRegisterEntry,
        representativeNames: check.representativeNames,
        representatives: check.representatives,
        ownershipStructureNotes: check.ownershipStructureNotes,
        beneficialOwners: check.beneficialOwners,
        idDocuments: check.idDocuments,
      });
      if (verificationErrors.length > 0) {
        throw new ActionError(verificationErrors.join(' '));
      }

      if (check.beneficialOwners.some((owner) => owner.isPep) && savedAnswers['pep'] !== 3) {
        throw new ActionError(
          'Wirtschaftlich Berechtigter ist als PEP markiert — der PEP-Risikofaktor muss ausdrücklich als PEP bewertet werden.',
        );
      }
      if (check.beneficialOwners.some((o) => o.isPep) && check.riskLevel !== 'HIGH') {
        throw new ActionError(
          'Wirtschaftlich Berechtigter ist als PEP markiert — bitte die Risikobewertung erneut durchführen (§ 15 GwG: zwingend hohes Risiko, jährliche Aktualisierung).',
        );
      }

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
    await emitN8nEvent(
      'gwg.verified',
      { tenantId, clientId, gwgCheckId: checkId, validUntil: verifiedValidUntil },
      { tenantId },
    );
  }
  revalidatePath(`/staff/clients/${clientId}`);
  revalidatePath(`/staff/clients/${clientId}/gwg`);
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

  const parsed = RejectSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { ok: false, error: 'Begründung erforderlich.' };
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
  revalidatePath(`/staff/clients/${clientId}/gwg`);
  return { ok: true };
}
