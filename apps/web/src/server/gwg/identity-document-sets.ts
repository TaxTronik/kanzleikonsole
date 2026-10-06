// =============================================================================
// GwG-Ausweis- und Rechtsträgernachweise: Satz erfassen bzw. ersetzen und
// Satz um Dateien ergänzen (Review-Befund K-03, vormals Callbacks in
// app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts).
//
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-RETENTION-DESTRUCTION-001
// (Originalbelege bleiben in der Akte). Reihenfolge der Prüfungen, Sperren,
// Schreibzugriffe und Audit-Ereignisse entspricht unverändert der früheren
// Action.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { GwgIdDocumentType } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import type { IdentitySourceView } from '@/lib/gwg/identity-viewport';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { organizeGwgDocumentsTx } from '@/server/gwg-onboarding/document-folders';
import { withEditableGwgCheckTx, type GwgStaffActor } from './editable-check';
import { lockCleanGwgEvidenceDocumentsTx } from './evidence-documents';
import {
  assertIdentityDatesForSubject,
  identitySubjectSourceOf,
  identityValidationFailure,
  isPersonalIdType,
  SUBJECT_NO_LONGER_PART_OF_CHECK,
  type ResolvedIdentitySubject,
} from './identity-document-validation';
import { validateIdentityViewportsTx, type IdentityPdfPageCounts } from './identity-source';
import {
  identityAssignmentForSubject,
  resolveIdentitySubject,
  type PersistedIdentityAssignment,
} from './identity-subject';

// --- Neuer bzw. ersetzender Satz ----------------------------------------------

export interface NewIdentityDocumentSetInput {
  checkId: string;
  clientId: string;
  type: GwgIdDocumentType;
  subjectKey?: string;
  number?: string;
  issuedBy?: string;
  issueDate?: string;
  expiryDate?: string;
  replacementMode: 'none' | 'set' | 'subject' | 'type';
  replaceDocumentSetId?: string;
  viewports: IdentitySourceView[];
  documentIds: string[];
}

const NO_IDENTITY_ASSIGNMENT: PersistedIdentityAssignment = {
  naturalClientSubjectId: null,
  beneficialOwnerSubjectId: null,
  representativeSubjectId: null,
};

/** Ausschnitte einer Datei des neuen Satzes, ohne Dateibezug (Speicherformat). */
export function newIdentityViewsFor(
  data: Pick<NewIdentityDocumentSetInput, 'viewports'>,
  documentId: string,
) {
  return data.viewports
    .filter((view) => view.documentId === documentId)
    .map(({ documentId: _documentId, ...view }) => view);
}

// GWG-IDENTIFICATION-EVIDENCE-001: pure extraction; invocation stays after the
// existing lifecycle, evidence and duplicate-link checks.
function newIdentityAssignmentConfirmedAt(data: NewIdentityDocumentSetInput): Date | null {
  // Complete metadata (including OCR) is not a human identity confirmation.
  void data;
  return null;
}

function newIdentityDocumentSharedData(
  data: NewIdentityDocumentSetInput,
  subject: ResolvedIdentitySubject,
  clientName: string,
  documentSetId: string,
  assignment: PersistedIdentityAssignment,
  assignmentConfirmedAt: Date | null,
  staffId: string,
) {
  return {
    gwgCheckId: data.checkId,
    type: data.type,
    ownerName: isPersonalIdType(data.type) ? subject!.name : clientName,
    number: isPersonalIdType(data.type) ? data.number || null : null,
    issuedBy: isPersonalIdType(data.type) ? data.issuedBy || null : null,
    issueDate: isPersonalIdType(data.type) && data.issueDate ? new Date(data.issueDate) : null,
    expiryDate: isPersonalIdType(data.type) && data.expiryDate ? new Date(data.expiryDate) : null,
    documentSetId,
    ...assignment,
    identityAssignmentConfirmedAt: assignmentConfirmedAt,
    identityAssignmentConfirmedBy: assignmentConfirmedAt ? staffId : null,
    verifiedAt: assignmentConfirmedAt,
  };
}

async function validateNewIdentityViews(
  tx: TxClient,
  tenantId: string,
  data: NewIdentityDocumentSetInput,
  pageCounts: IdentityPdfPageCounts,
) {
  if (data.viewports.some((view) => !data.documentIds.includes(view.documentId))) {
    throw new ActionError('Der Ausschnitt gehört nicht zur ausgewählten Ausweisdatei.');
  }
  const viewsByDocument = new Map<
    string,
    Awaited<ReturnType<typeof validateIdentityViewportsTx>>
  >();
  for (const documentId of data.documentIds) {
    try {
      const views = await validateIdentityViewportsTx(
        tx,
        {
          tenantId,
          clientId: data.clientId,
          documentId,
          views: newIdentityViewsFor(data, documentId),
        },
        pageCounts,
      );
      viewsByDocument.set(documentId, views);
    } catch (error) {
      throw identityValidationFailure(
        error,
        { tenantId, clientId: data.clientId, documentId },
        error instanceof Error ? error.message : 'Ausweisausschnitt konnte nicht geprüft werden.',
      );
    }
  }
  return viewsByDocument;
}

/** Bei Ausweisen: Person gegen den aktuellen Snapshot auflösen, nie aus Freitext. */
function resolveNewIdentitySubject(
  check: Parameters<typeof identitySubjectSourceOf>[0],
  data: NewIdentityDocumentSetInput,
): ResolvedIdentitySubject {
  const subjectSource = identitySubjectSourceOf(check);
  const subject = isPersonalIdType(data.type)
    ? resolveIdentitySubject(subjectSource, data.subjectKey ?? '')
    : null;
  if (isPersonalIdType(data.type) && !subject) {
    throw new ActionError(SUBJECT_NO_LONGER_PART_OF_CHECK);
  }
  assertIdentityDatesForSubject(subjectSource, subject, data.issueDate, data.expiryDate);
  return subject;
}

/** Sperrt die gewählten Aktenbelege und schließt eine Doppelzuordnung aus. */
async function assertLinkableEvidenceDocumentsTx(
  tx: TxClient,
  tenantId: string,
  data: NewIdentityDocumentSetInput,
): Promise<void> {
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
      documentId: data.documentIds.length === 1 ? data.documentIds[0] : { in: data.documentIds },
    },
    select: { id: true, type: true },
  });
  if (alreadyLinked) {
    throw new ActionError(
      'Dieser Aktenbeleg ist dieser GwG-Prüfung bereits zugeordnet. Bitte den vorhandenen Nachweis aufklappen und dort bearbeiten.',
    );
  }
}

function replacementTargetMissingMessage(mode: NewIdentityDocumentSetInput['replacementMode']) {
  return mode === 'set'
    ? 'Der zu ersetzende Ausweissatz ist nicht mehr vorhanden.'
    : mode === 'subject'
      ? 'Für diese Person ist kein aktiver Ausweissatz mehr vorhanden.'
      : 'Der zu ersetzende Rechtsträgernachweis ist nicht mehr vorhanden.';
}

/**
 * Pro Person gibt es genau einen aktiven Ausweissatz. Eine neue Erfassung
 * löst daher alle bisherigen aktiven Ausweise dieser Person ab. Bei
 * Rechtsträgern gilt dieselbe Invariante je Nachweistyp.
 */
async function findReplacedIdentityDocumentsTx(
  tx: TxClient,
  data: NewIdentityDocumentSetInput,
  assignment: PersistedIdentityAssignment,
) {
  const replacementWhere = isPersonalIdType(data.type)
    ? {
        gwgCheckId: data.checkId,
        type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] as GwgIdDocumentType[] },
        supersededAt: null,
        ...assignment,
      }
    : { gwgCheckId: data.checkId, type: data.type, supersededAt: null };
  const replacedDocuments = await tx.gwgIdDocument.findMany({
    where: replacementWhere,
    select: {
      id: true,
      documentSetId: true,
      documentId: true,
      type: true,
      ownerName: true,
      naturalClientSubjectId: true,
      beneficialOwnerSubjectId: true,
      representativeSubjectId: true,
      verifiedAt: true,
      identityAssignmentConfirmedAt: true,
    },
  });
  const explicitReplacement = data.replacementMode !== 'none';
  const requestedSetPresent =
    data.replacementMode !== 'set' ||
    replacedDocuments.some((entry) => entry.documentSetId === (data.replaceDocumentSetId || null));
  if (explicitReplacement && (replacedDocuments.length === 0 || !requestedSetPresent)) {
    throw new ActionError(replacementTargetMissingMessage(data.replacementMode));
  }
  return replacedDocuments;
}

async function supersedeReplacedDocumentsTx(
  tx: TxClient,
  checkId: string,
  replacedDocuments: Array<{ id: string }>,
  documentSetId: string,
): Promise<void> {
  if (replacedDocuments.length === 0) return;
  const superseded = await tx.gwgIdDocument.updateMany({
    where: {
      gwgCheckId: checkId,
      id: { in: replacedDocuments.map((entry) => entry.id) },
      supersededAt: null,
    },
    data: { supersededAt: new Date(), supersededByDocumentSetId: documentSetId },
  });
  if (superseded.count !== replacedDocuments.length) {
    throw new ActionError(
      'Der zu ersetzende Nachweis wurde parallel geändert. Bitte Seite neu laden und erneut versuchen.',
    );
  }
}

/** Legt die Zeilen des neuen Satzes an; liefert die Audit-Ressource. */
async function createIdentityDocumentRowsTx(
  tx: TxClient,
  data: NewIdentityDocumentSetInput,
  sharedData: ReturnType<typeof newIdentityDocumentSharedData>,
  viewsByDocument: Awaited<ReturnType<typeof validateNewIdentityViews>>,
): Promise<string> {
  if (data.documentIds.length === 1) {
    const idDoc = await tx.gwgIdDocument.create({
      data: {
        ...sharedData,
        documentId: data.documentIds[0]!,
        viewports: viewsByDocument.get(data.documentIds[0]!),
      },
    });
    return idDoc.id;
  }
  await tx.gwgIdDocument.createMany({
    data: data.documentIds.map((documentId) => ({
      ...sharedData,
      documentId,
      viewports: viewsByDocument.get(documentId),
    })),
  });
  return sharedData.documentSetId;
}

function newIdentityAuditAction(personal: boolean, replaced: boolean): string {
  if (replaced) return personal ? 'gwg.id_document.replace' : 'gwg.evidence.replace';
  return personal ? 'gwg.id_document.add' : 'gwg.evidence.add';
}

function newIdentityAuditAfter(
  data: NewIdentityDocumentSetInput,
  subject: ResolvedIdentitySubject,
  assignmentConfirmedAt: Date | null,
  replaced: boolean,
) {
  const personal = isPersonalIdType(data.type);
  return {
    type: data.type,
    ownerName: personal ? subject!.name : null,
    subjectKey: personal ? data.subjectKey : null,
    documentIds: data.documentIds,
    identityAssignmentConfirmedAt: assignmentConfirmedAt?.toISOString() ?? null,
    verifiedAt: assignmentConfirmedAt?.toISOString() ?? null,
    replacementMode:
      replaced && data.replacementMode === 'none'
        ? personal
          ? 'subject'
          : 'type'
        : data.replacementMode,
  };
}

/**
 * Erfasst einen Ausweissatz (bis zu zwei Dateien) oder einen
 * Rechtsträgernachweis aus der Akte und löst den bisherigen aktiven Satz
 * derselben Person bzw. desselben Nachweistyps ab. Die Zuordnung bleibt
 * unbestätigt, bis ein Mitarbeiter den gespeicherten Satz ausdrücklich prüft.
 */
export async function addIdentityDocumentSetTx(
  tx: TxClient,
  data: NewIdentityDocumentSetInput,
  actor: GwgStaffActor,
  pageCounts: IdentityPdfPageCounts,
): Promise<{ reviewReset: boolean } | undefined> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    {
      clientId: data.clientId,
      checkId: data.checkId,
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
    },
    async (check, mutation) => {
      const subject = resolveNewIdentitySubject(check, data);
      await mutation.claim();
      await assertLinkableEvidenceDocumentsTx(tx, actor.tenantId, data);

      const assignmentConfirmedAt = newIdentityAssignmentConfirmedAt(data);
      const assignment = subject ? identityAssignmentForSubject(subject) : NO_IDENTITY_ASSIGNMENT;
      const replacedDocuments = await findReplacedIdentityDocumentsTx(tx, data, assignment);
      const replaced = replacedDocuments.length > 0;

      const documentSetId = randomUUID();
      const viewsByDocument = await validateNewIdentityViews(tx, actor.tenantId, data, pageCounts);
      const sharedData = newIdentityDocumentSharedData(
        data,
        subject,
        check.client.name,
        documentSetId,
        assignment,
        assignmentConfirmedAt,
        actor.staffId,
      );
      await supersedeReplacedDocumentsTx(tx, data.checkId, replacedDocuments, documentSetId);
      const resourceId = await createIdentityDocumentRowsTx(tx, data, sharedData, viewsByDocument);
      await organizeGwgDocumentsTx(tx, {
        tenantId: actor.tenantId,
        clientId: data.clientId,
        createdByStaff: actor.staffId,
        documents: data.documentIds.map((documentId) => ({
          documentId,
          personName: subject?.name ?? null,
        })),
      });
      if (replaced) {
        await resolveNotificationsTx(tx, {
          tenantId: actor.tenantId,
          resources: replacedDocuments.map((entry) => ({
            resourceType: 'gwg_id_document',
            resourceId: entry.id,
          })),
        });
      }
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: newIdentityAuditAction(isPersonalIdType(data.type), replaced),
        resourceType: data.documentIds.length === 1 ? 'gwg_id_document' : 'gwg_id_document_set',
        resourceId,
        before: replaced ? { replacedDocuments } : undefined,
        after: newIdentityAuditAfter(data, subject, assignmentConfirmedAt, replaced),
      });
      return replaced ? { reviewReset: check.status === 'IN_REVIEW' } : undefined;
    },
  );
}

// --- Satz um Dateien ergänzen ---------------------------------------------------

export interface IdentityDocumentSetExtensionInput {
  checkId: string;
  clientId: string;
  targetDocumentSetId: string;
  documentIds: string[];
}

type ActiveIdentityDocument = Awaited<ReturnType<typeof loadActiveIdentityDocumentsTx>>[number];

/** Erst nach Parent- und Set-Lock lesen: Kapazität, Bestätigung und Quellsätze sind stabil. */
async function loadActiveIdentityDocumentsTx(tx: TxClient, checkId: string) {
  return tx.gwgIdDocument.findMany({
    where: { gwgCheckId: checkId, supersededAt: null },
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
}

function extensionTargetDocuments(
  existingDocuments: ActiveIdentityDocument[],
  targetDocumentSetId: string,
): ActiveIdentityDocument[] {
  const targetDocuments = existingDocuments.filter(
    (entry) => entry.documentSetId === targetDocumentSetId,
  );
  if (
    targetDocuments.length === 0 ||
    targetDocuments.some((entry) => !isPersonalIdType(entry.type))
  ) {
    throw new ActionError(
      'Der Ziel-Ausweissatz ist nicht mehr vorhanden oder enthält keinen Personalausweis/Reisepass.',
    );
  }
  return targetDocuments;
}

function isConfirmedOrForeignSourceDocument(entry: ActiveIdentityDocument): boolean {
  return (
    !isPersonalIdType(entry.type) ||
    entry.verifiedAt !== null ||
    entry.identityAssignmentConfirmedAt !== null ||
    entry.identityAssignmentConfirmedBy !== null
  );
}

/** Bereits verknüpfte Auswahl: nur offene Ausweissätze dürfen vollständig verschoben werden. */
function extensionSources(
  existingDocuments: ActiveIdentityDocument[],
  data: IdentityDocumentSetExtensionInput,
) {
  const selectedIds = new Set(data.documentIds);
  const selectedLinked = existingDocuments.filter(
    (entry) => entry.documentId !== null && selectedIds.has(entry.documentId),
  );
  if (selectedLinked.some((entry) => entry.documentSetId === data.targetDocumentSetId)) {
    throw new ActionError('Mindestens eine ausgewählte Datei gehört bereits zum Ziel-Ausweissatz.');
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
  if (sourceDocuments.some(isConfirmedOrForeignSourceDocument)) {
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
  return { sourceSetIds, sourceDocuments, unlinkedDocumentIds };
}

/** Höchstens zwei Dateien je Satz; jede Datei muss noch als Aktenbeleg vorhanden sein. */
function mergedIdentitySetDocumentIds(
  targetDocuments: ActiveIdentityDocument[],
  sourceDocuments: ActiveIdentityDocument[],
  unlinkedDocumentIds: string[],
): string[] {
  const finalDocumentCount =
    targetDocuments.length + sourceDocuments.length + unlinkedDocumentIds.length;
  if (finalDocumentCount > 2) {
    throw new ActionError(
      `Der zusammengeführte Ausweissatz hätte ${finalDocumentCount} Dateien. Zulässig sind höchstens zwei.`,
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
  return [
    ...new Set(allDocumentIds.filter((documentId): documentId is string => documentId !== null)),
  ].sort();
}

/** Gemeinsame Werte des Zielsatzes; jede Strukturänderung entwertet die Bestätigung. */
function extendedSetSharedData(targetDocumentSetId: string, first: ActiveIdentityDocument) {
  return {
    documentSetId: targetDocumentSetId,
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
}

/**
 * Ergänzt einen bestehenden Ausweissatz direkt aus der Akte. Unverknüpfte
 * Dateien werden angelegt; ein anderer, noch unbestätigter Alt-Satz wird als
 * Ganzes verschoben. Jede strukturelle Änderung entwertet die bisherige
 * Bestätigung des Ziels, damit Vorder-/Rückseite anschließend gemeinsam erneut
 * geprüft werden müssen.
 */
export async function extendIdentityDocumentSetTx(
  tx: TxClient,
  data: IdentityDocumentSetExtensionInput,
  actor: GwgStaffActor,
): Promise<{ reviewReset: boolean }> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    { clientId: data.clientId, checkId: data.checkId, select: { status: true } },
    async (check, mutation) => {
      await mutation.claim();

      const targetLockKey = `gwg-document-set:${data.targetDocumentSetId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${targetLockKey}, 0))`;

      const existingDocuments = await loadActiveIdentityDocumentsTx(tx, data.checkId);
      const targetDocuments = extensionTargetDocuments(existingDocuments, data.targetDocumentSetId);
      const { sourceSetIds, sourceDocuments, unlinkedDocumentIds } = extensionSources(
        existingDocuments,
        data,
      );
      const uniqueDocumentIds = mergedIdentitySetDocumentIds(
        targetDocuments,
        sourceDocuments,
        unlinkedDocumentIds,
      );
      if (
        !(await lockCleanGwgEvidenceDocumentsTx(tx, {
          tenantId: actor.tenantId,
          clientId: data.clientId,
          documentIds: uniqueDocumentIds,
        }))
      ) {
        throw new ActionError(
          'Alle Dateien des Ziel-/Quellsatzes und der Auswahl müssen verfügbare GwG-Belege mit vollständig geprüfter, sauberer Dateiversion desselben Mandanten sein.',
        );
      }

      const first = targetDocuments[0]!;
      const sharedData = extendedSetSharedData(data.targetDocumentSetId, first);
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
      await organizeGwgDocumentsTx(tx, {
        tenantId: actor.tenantId,
        clientId: data.clientId,
        createdByStaff: actor.staffId,
        documents: uniqueDocumentIds.map((documentId) => ({
          documentId,
          personName: first.ownerName,
        })),
      });

      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
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
  );
}
