'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { revokeAllSessions } from '@/server/auth/revocation';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
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
    },
  });
  if (claim.count === 0) {
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
});

const TERMINAL_GWG_STATUSES = ['VERIFIED', 'REJECTED', 'EXPIRED'] as const;

async function startCheckCycle(formData: FormData): Promise<ActionResult> {
  const parsed = OpenSchema.safeParse({
    clientId: formData.get('clientId'),
    expectedLatestCheckId: formData.get('expectedLatestCheckId') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { clientId, expectedLatestCheckId } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
      await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
      const latest = await tx.gwgCheck.findFirst({
        where: { clientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          beneficialOwners: true,
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
      const review = await startFreshGwgReviewTx(tx, { tenantId, clientId });
      const checkId = review.reviewCheckId;

      // Ein vernichteter Alt-Snapshot darf niemals wieder materialisiert
      // werden. Der gemeinsame Lifecycle-Lock serialisiert Check-Vernichtung
      // und Neustart; diese Prüfung schützt zusätzlich bereits vernichtete
      // Bestandsdaten.
      const snapshotSource = latest && latest.destroyedAt === null ? latest : null;
      const ownersToCopy = snapshotSource?.beneficialOwners ?? [];
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
          return {
            gwgCheckId: checkId,
            type: document.type,
            ownerName: document.ownerName,
            documentId: reusableDocumentId,
            number: document.number,
            issuedBy: document.issuedBy,
            issueDate: document.issueDate,
            expiryDate: document.expiryDate,
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
        },
      });
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
): Promise<ActionResult> {
  return startCheckCycle(formData);
}

const AnswersSchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
  answers: z.record(z.string(), z.coerce.number().int().min(0).max(3)),
});

export async function saveRiskAnswersAction(input: {
  checkId: string;
  clientId: string;
  answers: Record<string, number>;
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

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
      const before = await tx.gwgCheck.findFirst({ where: { id: checkId, clientId } });
      if (!before) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(before.status);
      await claimCheckMutation(tx, {
        checkId,
        clientId,
        expectedStatus: before.status,
      });
      const updated = await tx.gwgCheck.update({
        where: { id: checkId },
        data: {
          riskAnswers: answers,
          riskScore: result.score,
          riskLevel: result.level,
          riskBreakdown: { factors: result.breakdown } as unknown as Prisma.InputJsonValue,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.check.assess',
        resourceType: 'gwg_check',
        resourceId: checkId,
        before: { riskScore: before.riskScore, riskLevel: before.riskLevel },
        after: { riskScore: updated.riskScore, riskLevel: updated.riskLevel },
      });
    },
    { revalidate: `/staff/clients/${clientId}/gwg` },
  );
}

const LegalEntityDetailsSchema = z
  .object({
    checkId: z.string().uuid(),
    clientId: z.string().uuid(),
    legalForm: z.string().trim().min(1).max(100),
    registerNumber: z.string().trim().max(100).optional().or(z.literal('')),
    registerAuthority: z.string().trim().max(200).optional().or(z.literal('')),
    noRegisterEntry: z.boolean(),
    representativeNamesText: z.string().max(4000),
    ownershipStructureNotes: z.string().trim().min(1).max(10000),
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
    const representatives = value.representativeNamesText
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (representatives.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['representativeNamesText'],
        message: 'Mindestens ein Vertreter erforderlich.',
      });
    }
  });

export async function saveLegalEntityDetailsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = LegalEntityDetailsSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    legalForm: formData.get('legalForm'),
    registerNumber: formData.get('registerNumber') ?? '',
    registerAuthority: formData.get('registerAuthority') ?? '',
    noRegisterEntry: formData.get('noRegisterEntry') === 'on',
    representativeNamesText: formData.get('representativeNamesText'),
    ownershipStructureNotes: formData.get('ownershipStructureNotes'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(' ') };
  }
  const data = parsed.data;
  const representativeNames = Array.from(
    new Set(
      data.representativeNamesText
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  );

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: {
          status: true,
          legalForm: true,
          registerNumber: true,
          registerAuthority: true,
          noRegisterEntry: true,
          representativeNames: true,
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
      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });

      const after = {
        legalForm: data.legalForm,
        registerNumber: data.noRegisterEntry ? null : data.registerNumber || null,
        registerAuthority: data.noRegisterEntry ? null : data.registerAuthority || null,
        noRegisterEntry: data.noRegisterEntry,
        representativeNames,
        ownershipStructureNotes: data.ownershipStructureNotes,
      };
      await tx.gwgCheck.update({
        where: { id: data.checkId },
        data: after,
      });
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
        after,
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
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
): Promise<ActionResult> {
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
  });
  if (!parsed.success) return { ok: false, error: 'Ungültige Angaben zur Person.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, data.clientId);
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
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      const owner = check.beneficialOwners[0];
      if (!owner) throw new ActionError('Wirtschaftlich Berechtigter nicht gefunden.');
      assertGwgEditable(check.status);

      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
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
        },
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
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
    ownerName: z.string().max(200).optional().or(z.literal('')),
    number: z.string().max(100).optional().or(z.literal('')),
    issuedBy: z.string().max(200).optional().or(z.literal('')),
    issueDate: z.string().date().optional().or(z.literal('')),
    expiryDate: z.string().date().optional().or(z.literal('')),
    documentId: z.string().uuid(),
  })
  .superRefine((value, ctx) => {
    if (!isPersonalIdType(value.type)) return;
    for (const [field, message] of [
      ['ownerName', 'Name der identifizierten Person ist erforderlich.'],
      ['number', 'Ausweisnummer ist erforderlich.'],
      ['issuedBy', 'Ausstellende Behörde ist erforderlich.'],
      ['expiryDate', 'Gültigkeitsdatum ist erforderlich.'],
    ] as const) {
      if (!value[field]?.trim()) {
        ctx.addIssue({ code: 'custom', path: [field], message });
      }
    }
  });

export async function addIdDocumentAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
) {
  const parsed = AddIdDocSchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
    type: formData.get('type'),
    ownerName: formData.get('ownerName') ?? '',
    number: formData.get('number') ?? '',
    issuedBy: formData.get('issuedBy') ?? '',
    issueDate: formData.get('issueDate') ?? '',
    expiryDate: formData.get('expiryDate') ?? '',
    documentId: formData.get('documentId') ?? '',
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
      // Check laden + Status prüfen (bindet checkId an den autorisierten Mandanten).
      const check = await tx.gwgCheck.findFirst({
        where: { id: data.checkId, clientId: data.clientId },
        select: { status: true, client: { select: { name: true, kind: true } } },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      assertGwgEditable(check.status);
      await claimCheckMutation(tx, {
        checkId: data.checkId,
        clientId: data.clientId,
        expectedStatus: check.status,
      });
      if (data.documentId) {
        const evidenceDocument = await tx.document.findFirst({
          where: {
            id: data.documentId,
            tenantId,
            clientId: data.clientId,
            classification: 'GWG_EVIDENCE',
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!evidenceDocument) {
          throw new ActionError(
            'Der verknüpfte Nachweis muss ein nicht gelöschtes GwG-Dokument desselben Mandanten sein.',
          );
        }
      }
      const idDoc = await tx.gwgIdDocument.create({
        data: {
          gwgCheckId: data.checkId,
          type: data.type,
          ownerName: isPersonalIdType(data.type) ? data.ownerName!.trim() : check.client.name,
          number: isPersonalIdType(data.type) ? data.number || null : null,
          issuedBy: isPersonalIdType(data.type) ? data.issuedBy || null : null,
          issueDate:
            isPersonalIdType(data.type) && data.issueDate ? new Date(data.issueDate) : null,
          expiryDate:
            isPersonalIdType(data.type) && data.expiryDate ? new Date(data.expiryDate) : null,
          documentId: data.documentId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: isPersonalIdType(data.type) ? 'gwg.id_document.add' : 'gwg.evidence.add',
        resourceType: 'gwg_id_document',
        resourceId: idDoc.id,
        after: {
          type: data.type,
          ownerName: isPersonalIdType(data.type) ? data.ownerName : null,
          documentId: data.documentId,
        },
      });
    },
    { revalidate: `/staff/clients/${data.clientId}/gwg` },
  );
}

const VerifySchema = z.object({
  checkId: z.string().uuid(),
  clientId: z.string().uuid(),
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
  const parsed = VerifySchema.safeParse({
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
          client: { select: { kind: true, name: true } },
          beneficialOwners: true,
          idDocuments: {
            include: {
              document: {
                select: { clientId: true, classification: true, deletedAt: true },
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
        clientId,
        clientKind: check.client.kind,
        legalForm: check.legalForm,
        registerNumber: check.registerNumber,
        registerAuthority: check.registerAuthority,
        noRegisterEntry: check.noRegisterEntry,
        representativeNames: check.representativeNames,
        ownershipStructureNotes: check.ownershipStructureNotes,
        beneficialOwners: check.beneficialOwners,
        idDocuments: check.idDocuments,
      });
      if (verificationErrors.length > 0) {
        throw new ActionError(verificationErrors.join(' '));
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

  const parsed = VerifySchema.safeParse({
    checkId: formData.get('checkId'),
    clientId: formData.get('clientId'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler — ungültige IDs.' };
  const { checkId, clientId } = parsed.data;

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
          client: { select: { kind: true } },
          beneficialOwners: true,
          idDocuments: {
            include: {
              document: {
                select: { clientId: true, classification: true, deletedAt: true },
              },
            },
          },
        },
      });
      if (!check) throw new ActionError('GwG-Check nicht gefunden.');
      await assertLatestCheckForDecision(tx, { clientId, checkId });
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
      // P2-2 / § 10 Abs. 1 Nr. 2, § 3 GwG: Bei juristischen Personen und
      // Personengesellschaften ist mindestens EIN wirtschaftlich Berechtigter
      // zu ermitteln (fiktiv-wB, wenn keiner > 25 % hält).
      const clientKind = await tx.client.findUnique({
        where: { id: clientId },
        select: { kind: true },
      });
      if (
        (clientKind?.kind === 'JURPERS' || clientKind?.kind === 'PERSGES') &&
        check.beneficialOwners.length === 0
      ) {
        throw new ActionError(
          'Bei juristischen Personen/Personengesellschaften ist mindestens ein wirtschaftlich Berechtigter zu erfassen (§ 10 Abs. 1 Nr. 2 GwG).',
        );
      }
      // P2-3 / § 12 Abs. 1, § 8 GwG: Es muss mindestens EIN identifikations-
      // taugliches Dokument (kein VOLLMACHT/SONSTIGES) mit hinterlegter Kopie
      // (documentId) und — falls ein Ablaufdatum erfasst ist — GÜLTIGER
      // Ausweis (nicht abgelaufen) vorliegen.
      const ID_SUITABLE: string[] = [
        'PERSONALAUSWEIS',
        'REISEPASS',
        'HANDELSREGISTERAUSZUG',
        'GESELLSCHAFTSVERTRAG',
        'TRANSPARENZREGISTER_AUSZUG',
      ];
      const heute = new Date();
      const taugliches = check.idDocuments.find(
        (d) =>
          ID_SUITABLE.includes(d.type) &&
          d.documentId != null &&
          (d.expiryDate == null || d.expiryDate.getTime() >= heute.getTime()),
      );
      if (!taugliches) {
        throw new ActionError(
          'Kein gültiges, identifikationstaugliches Ausweisdokument mit hinterlegter Kopie (§ 12 Abs. 1 GwG). Bitte amtlichen Ausweis/Registerauszug mit Datei und gültigem Ablaufdatum erfassen.',
        );
      }
      // H-2 / § 15 GwG: Ist ein wirtschaftlich Berechtigter als PEP markiert,
      // MUSS die Risikostufe HIGH sein (jährliche Überwachung). Bei
      // widersprechender Bewertung Verifikation blockieren — die erneute
      // Risikobewertung erzwingt über den PEP-Override HIGH.
      const verificationErrors = gwgVerificationErrors({
        clientId,
        clientKind: check.client.kind,
        legalForm: check.legalForm,
        registerNumber: check.registerNumber,
        registerAuthority: check.registerAuthority,
        noRegisterEntry: check.noRegisterEntry,
        representativeNames: check.representativeNames,
        ownershipStructureNotes: check.ownershipStructureNotes,
        beneficialOwners: check.beneficialOwners,
        idDocuments: check.idDocuments,
      });
      if (verificationErrors.length > 0) {
        throw new ActionError(verificationErrors.join(' '));
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
          reviewSubmittedAt: check.reviewSubmittedAt ?? new Date(),
          reviewSubmittedBy: check.reviewSubmittedBy ?? staffId,
        },
      });
      if (claim.count === 0) {
        throw new ActionError('GwG-Check ist nicht mehr im Prüfstatus — bitte Seite neu laden.');
      }

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
      n8nEvent: 'client.created',
      n8nPayload: { tenantId, clientId, gwgVerified: true },
      fallback: {
        subject: 'Willkommen — Ihre Mandantschaft ist nun aktiv',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nIhre Mandantschaft ist jetzt vollständig eingerichtet. Loggen Sie sich gerne in Ihr Mandantenportal ein:\n\n{{portalUrl}}',
      },
    }),
  );
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
