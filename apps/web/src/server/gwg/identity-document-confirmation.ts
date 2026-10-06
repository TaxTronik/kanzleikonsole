// =============================================================================
// GwG-Ausweissatz korrigieren bzw. ausdrücklich bestätigen (Review-Befund
// K-03, vormals Callback von updateIdDocumentsAction in
// app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts).
//
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001. Die Person kommt niemals aus
// Freitext, sondern wird gegen den aktuellen GwG-Snapshot aufgelöst; bestätigt
// wird nur der exakt gespeicherte Satz. Reihenfolge der Prüfungen, Sperren,
// Schreibzugriffe und Audit-Ereignisse entspricht unverändert der früheren
// Action.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { identityViewports } from '@/lib/gwg/identity-viewport';
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
} from './identity-document-validation';
import { validateIdentityViewportsTx, type IdentityPdfPageCounts } from './identity-source';
import {
  identityAssignmentForSubject,
  resolveIdentitySubject,
  type IdentitySubjectOption,
} from './identity-subject';
import { gwgIdentityDocumentSetRevision, type IdentityDocumentRevisionSource } from './revisions';

export interface IdentityDocumentSetUpdateInput {
  intent: 'save' | 'confirm';
  checkId: string;
  clientId: string;
  documentSetId: string;
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  subjectKey: string;
  number: string;
  issuedBy: string;
  issueDate: string;
  expiryDate: string;
  expectedRevision: string;
}

export interface SavedIdentityDocumentSet {
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  subjectKey: string;
  ownerName: string;
  number: string;
  issuedBy: string;
  issueDate: string;
  expiryDate: string;
}

export type IdentityDocumentSetUpdateResult = {
  verified: boolean;
  reviewReset: boolean;
  saved: SavedIdentityDocumentSet;
  revision: string;
};

function isDateOnOrAfterToday(value: string, now: Date = new Date()): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Number.isFinite(date.getTime()) && date.getTime() >= today;
}

const IDENTITY_SET_SELECT = {
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
  viewports: true,
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
} as const;

interface StoredIdentitySetDocument {
  id: string;
  type: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  viewports: unknown;
  document: {
    id: string;
    tenantId: string;
    clientId: string | null;
    classification: string;
    deletedAt: Date | null;
    gwgDestructionRequestedAt: Date | null;
    gwgDestroyedAt: Date | null;
  } | null;
}

type IdentitySetDocument = StoredIdentitySetDocument & IdentityDocumentRevisionSource;

function isUnavailableEvidence(
  entry: StoredIdentitySetDocument,
  scope: { tenantId: string; clientId: string },
): boolean {
  return (
    !entry.document ||
    entry.document.id === null ||
    entry.document.tenantId !== scope.tenantId ||
    entry.document.clientId !== scope.clientId ||
    entry.document.classification !== 'GWG_EVIDENCE' ||
    entry.document.deletedAt !== null ||
    entry.document.gwgDestructionRequestedAt !== null ||
    entry.document.gwgDestroyedAt !== null
  );
}

/** Satz vollständig, unverändert (CAS) und jede Datei noch als GwG-Nachweis verfügbar. */
function assertIdentitySetUpdatable(
  documents: IdentitySetDocument[],
  data: IdentityDocumentSetUpdateInput,
  tenantId: string,
): void {
  if (documents.length === 0 || documents.some((document) => !isPersonalIdType(document.type))) {
    throw new ActionError(
      'Der Ausweissatz ist unvollständig oder gehört nicht zu dieser GwG-Prüfung.',
    );
  }
  if (gwgIdentityDocumentSetRevision(documents) !== data.expectedRevision) {
    throw new ActionError(
      'Der Ausweissatz wurde zwischenzeitlich geändert. Bitte Seite neu laden; Ihre Eingabe wurde nicht überschrieben.',
    );
  }
  if (
    documents.some((entry) => isUnavailableEvidence(entry, { tenantId, clientId: data.clientId }))
  ) {
    throw new ActionError(
      'Mindestens eine Datei dieses Ausweissatzes ist nicht mehr als GwG-Nachweis verfügbar.',
    );
  }
  if (data.intent === 'confirm' && !isDateOnOrAfterToday(data.expiryDate)) {
    throw new ActionError(
      'Der Ausweis ist abgelaufen. Bitte ein gültiges Ablaufdatum oder einen neuen Ausweis erfassen.',
    );
  }
}

/** Bestätigt wird nur der gespeicherte Stand: abweichende Eingaben erst speichern. */
function assertConfirmingSavedValues(
  documents: IdentitySetDocument[],
  data: IdentityDocumentSetUpdateInput,
  subject: IdentitySubjectOption,
): void {
  const currentAssignment = identityAssignmentForSubject(subject);
  if (
    documents.some(
      (entry) =>
        entry.type !== data.type ||
        entry.number !== data.number ||
        entry.issuedBy !== data.issuedBy ||
        entry.issueDate?.toISOString().slice(0, 10) !== data.issueDate ||
        entry.expiryDate?.toISOString().slice(0, 10) !== data.expiryDate ||
        Object.entries(currentAssignment).some(
          ([key, value]) => entry[key as keyof typeof entry] !== value,
        ),
    )
  ) {
    throw new ActionError(
      'Bitte geänderte Angaben zuerst speichern und anschließend den gespeicherten Ausweis prüfen.',
    );
  }
}

/** Gespeicherte Ausschnitte müssen weiterhin exakt zur Quelle passen. */
async function revalidateSavedIdentityViewsTx(
  tx: TxClient,
  documents: StoredIdentitySetDocument[],
  scope: { tenantId: string; clientId: string },
  pageCounts: IdentityPdfPageCounts,
): Promise<void> {
  for (const entry of documents) {
    try {
      await validateIdentityViewportsTx(
        tx,
        {
          tenantId: scope.tenantId,
          clientId: scope.clientId,
          documentId: entry.document!.id,
          views: identityViewports(entry.viewports),
        },
        pageCounts,
      );
    } catch (error) {
      throw identityValidationFailure(
        error,
        { tenantId: scope.tenantId, clientId: scope.clientId, documentId: entry.document!.id },
        'Die gespeicherte Ausweisansicht passt nicht mehr zur Quelle. Bitte den Nachweis neu erfassen.',
      );
    }
  }
}

function savedIdentityDocumentSet(
  data: IdentityDocumentSetUpdateInput,
  ownerName: string,
): SavedIdentityDocumentSet {
  return {
    type: data.type,
    subjectKey: data.subjectKey,
    ownerName,
    number: data.number,
    issuedBy: data.issuedBy,
    issueDate: data.issueDate,
    expiryDate: data.expiryDate,
  };
}

/**
 * Bestätigt oder korrigiert einen zusammengehörigen Ausweissatz (z. B.
 * Vorder- und Rückseite) in einem atomaren Schritt. Die Person kommt niemals
 * aus Freitext, sondern wird gegen den aktuellen GwG-Snapshot aufgelöst.
 */
export async function updateIdentityDocumentSetTx(
  tx: TxClient,
  data: IdentityDocumentSetUpdateInput,
  actor: GwgStaffActor,
  pageCounts: IdentityPdfPageCounts,
): Promise<IdentityDocumentSetUpdateResult> {
  const { tenantId, staffId } = actor;
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
        idDocuments: {
          where: { documentSetId: data.documentSetId, supersededAt: null },
          select: IDENTITY_SET_SELECT,
        },
      },
    },
    async (check, mutation): Promise<IdentityDocumentSetUpdateResult> => {
      assertIdentitySetUpdatable(check.idDocuments, data, tenantId);

      const subjectSource = identitySubjectSourceOf(check);
      const subject = resolveIdentitySubject(subjectSource, data.subjectKey);
      if (!subject) throw new ActionError(SUBJECT_NO_LONGER_PART_OF_CHECK);
      assertIdentityDatesForSubject(subjectSource, subject, data.issueDate, data.expiryDate);

      await mutation.claim();
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
      if (data.intent === 'confirm') {
        assertConfirmingSavedValues(check.idDocuments, data, subject);
        await revalidateSavedIdentityViewsTx(
          tx,
          check.idDocuments,
          { tenantId, clientId: data.clientId },
          pageCounts,
        );
      }
      const verifiedAt = data.intent === 'confirm' ? new Date() : null;
      const assignment = identityAssignmentForSubject(subject);
      const update = await tx.gwgIdDocument.updateMany({
        where: {
          documentSetId: data.documentSetId,
          gwgCheckId: data.checkId,
          supersededAt: null,
        },
        data: {
          type: data.type,
          ownerName: subject.name,
          number: data.number,
          issuedBy: data.issuedBy,
          issueDate: new Date(data.issueDate),
          expiryDate: new Date(data.expiryDate),
          ...assignment,
          identityAssignmentConfirmedAt: verifiedAt,
          identityAssignmentConfirmedBy: verifiedAt ? staffId : null,
          verifiedAt,
        },
      });
      if (update.count !== check.idDocuments.length) {
        throw new ActionError(
          'Der Ausweissatz wurde parallel geändert. Bitte Seite neu laden und erneut prüfen.',
        );
      }
      await organizeGwgDocumentsTx(tx, {
        tenantId,
        clientId: data.clientId,
        createdByStaff: staffId,
        documents: check.idDocuments.map((document) => ({
          documentId: document.document!.id,
          personName: subject.name,
        })),
      });
      if (verifiedAt)
        await resolveNotificationsTx(tx, {
          tenantId,
          resources: check.idDocuments.map((document) => ({
            resourceType: 'gwg_id_document',
            resourceId: document.id,
          })),
        });
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
          verifiedAt: verifiedAt?.toISOString() ?? null,
          intent: data.intent,
        },
      });
      return {
        verified: verifiedAt !== null,
        reviewReset: check.status === 'IN_REVIEW',
        saved: savedIdentityDocumentSet(data, subject.name),
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
            identityAssignmentConfirmedBy: verifiedAt ? staffId : null,
            verifiedAt,
          })),
        ),
      };
    },
  );
}
