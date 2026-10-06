// =============================================================================
// GwG-Nachweise im aktiven Prüfsnapshot: irrtümliche Zuordnung lösen und bei
// historischen Doppelbeständen den aktuellen Ausweissatz festlegen
// (Review-Befund K-03, vormals Callbacks in
// app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts).
//
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001. Originalbelege bleiben in der
// Mandantenakte. Reihenfolge der Prüfungen, Schreibzugriffe und
// Audit-Ereignisse entspricht unverändert der früheren Action.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { withEditableGwgCheckTx, type GwgStaffActor } from './editable-check';
import { isPersonalIdType } from './identity-document-validation';
import type { PersistedIdentityAssignment } from './identity-subject';

// --- Zuordnung lösen --------------------------------------------------------------

export interface GwgEvidenceLinkRemovalInput {
  checkId: string;
  clientId: string;
  gwgIdDocumentId: string;
}

/**
 * Entfernt ausschließlich eine irrtümliche Zuordnung aus dem aktiven
 * GwG-Prüfsnapshot. Das Document und sämtliche Object-Store-Versionen bleiben
 * unverändert in der Mandantenakte erhalten (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export async function removeGwgEvidenceLinkTx(
  tx: TxClient,
  data: GwgEvidenceLinkRemovalInput,
  actor: GwgStaffActor,
): Promise<{ reviewReset: boolean }> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    { clientId: data.clientId, checkId: data.checkId, select: { status: true } },
    async (check, mutation) => {
      await mutation.claim();

      const linkedEvidence = await tx.gwgIdDocument.findFirst({
        where: {
          id: data.gwgIdDocumentId,
          gwgCheckId: data.checkId,
          supersededAt: null,
        },
        select: {
          id: true,
          documentId: true,
          documentSetId: true,
          type: true,
          ownerName: true,
          naturalClientSubjectId: true,
          beneficialOwnerSubjectId: true,
          representativeSubjectId: true,
        },
      });
      if (!linkedEvidence) {
        throw new ActionError(
          'Der aktive Nachweis ist nicht mehr vorhanden. Bitte Seite neu laden.',
        );
      }

      const removed = await tx.gwgIdDocument.deleteMany({
        where: {
          id: linkedEvidence.id,
          gwgCheckId: data.checkId,
          supersededAt: null,
        },
      });
      if (removed.count !== 1) {
        throw new ActionError(
          'Der Nachweis wurde parallel geändert. Bitte Seite neu laden und erneut versuchen.',
        );
      }

      const personal = isPersonalIdType(linkedEvidence.type);
      if (personal) {
        // Schon eine entfernte Vorder-/Rückseite ändert den geprüften Satz. Eine
        // etwaige Restseite muss deshalb vor einer Entscheidung erneut bestätigt
        // werden.
        await tx.gwgIdDocument.updateMany({
          where: {
            gwgCheckId: data.checkId,
            documentSetId: linkedEvidence.documentSetId,
            supersededAt: null,
          },
          data: {
            identityAssignmentConfirmedAt: null,
            identityAssignmentConfirmedBy: null,
            verifiedAt: null,
          },
        });
      }

      await resolveNotificationsTx(tx, {
        tenantId: actor.tenantId,
        resources: [{ resourceType: 'gwg_id_document', resourceId: linkedEvidence.id }],
      });
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: personal ? 'gwg.id_document.unlink' : 'gwg.evidence.unlink',
        resourceType: 'gwg_id_document',
        resourceId: linkedEvidence.id,
        before: linkedEvidence,
        after: {
          gwgCheckId: data.checkId,
          documentRetainedInClientFile: true,
          documentId: linkedEvidence.documentId,
        },
      });
      return { reviewReset: check.status === 'IN_REVIEW' };
    },
  );
}

// --- Aktuellen Satz festlegen -------------------------------------------------------

export interface CurrentIdentityDocumentSetInput {
  checkId: string;
  clientId: string;
  documentSetId: string;
}

/** Der gewählte Satz muss genau einer Person eindeutig zugeordnet sein. */
function uniqueSelectionAssignment(
  selectedDocuments: Array<PersistedIdentityAssignment>,
): PersistedIdentityAssignment {
  const selected = selectedDocuments[0];
  if (!selected) {
    throw new ActionError('Der ausgewählte aktive Ausweissatz ist nicht mehr vorhanden.');
  }
  const assignment = {
    naturalClientSubjectId: selected.naturalClientSubjectId,
    beneficialOwnerSubjectId: selected.beneficialOwnerSubjectId,
    representativeSubjectId: selected.representativeSubjectId,
  };
  const assignedSubjects = Object.values(assignment).filter((value) => value !== null);
  const consistentSelection =
    assignedSubjects.length === 1 &&
    selectedDocuments.every(
      (entry) =>
        entry.naturalClientSubjectId === assignment.naturalClientSubjectId &&
        entry.beneficialOwnerSubjectId === assignment.beneficialOwnerSubjectId &&
        entry.representativeSubjectId === assignment.representativeSubjectId,
    );
  if (!consistentSelection) {
    throw new ActionError(
      'Der ausgewählte Ausweissatz besitzt keine eindeutige Personenzuordnung und kann nicht als aktuell festgelegt werden.',
    );
  }
  return assignment;
}

/**
 * Repariert historische Doppelbestände, ohne einen fachlich aktuellen Satz
 * automatisch zu erraten. Der Mitarbeiter wählt den aktuellen Satz bewusst;
 * alle übrigen aktiven Ausweise derselben Person werden als Alt-Nachweise
 * markiert (GWG-IDENTIFICATION-EVIDENCE-001).
 */
export async function selectCurrentIdentityDocumentSetTx(
  tx: TxClient,
  data: CurrentIdentityDocumentSetInput,
  actor: GwgStaffActor,
): Promise<{ reviewReset: boolean }> {
  return withEditableGwgCheckTx(
    tx,
    actor,
    { clientId: data.clientId, checkId: data.checkId, select: { status: true } },
    async (check, mutation) => {
      await mutation.claim();

      const selectedDocuments = await tx.gwgIdDocument.findMany({
        where: {
          gwgCheckId: data.checkId,
          documentSetId: data.documentSetId,
          type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] },
          supersededAt: null,
        },
        select: {
          id: true,
          documentSetId: true,
          documentId: true,
          type: true,
          naturalClientSubjectId: true,
          beneficialOwnerSubjectId: true,
          representativeSubjectId: true,
        },
      });
      const assignment = uniqueSelectionAssignment(selectedDocuments);

      const activeDocuments = await tx.gwgIdDocument.findMany({
        where: {
          gwgCheckId: data.checkId,
          type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] },
          supersededAt: null,
          ...assignment,
        },
        select: { id: true, documentSetId: true, documentId: true, type: true },
      });
      const supersededDocuments = activeDocuments.filter(
        (entry) => entry.documentSetId !== data.documentSetId,
      );
      if (supersededDocuments.length === 0) {
        throw new ActionError('Dieser Ausweis ist bereits der einzige aktive Satz der Person.');
      }

      const superseded = await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: data.checkId,
          id: { in: supersededDocuments.map((entry) => entry.id) },
          supersededAt: null,
        },
        data: {
          supersededAt: new Date(),
          supersededByDocumentSetId: data.documentSetId,
        },
      });
      if (superseded.count !== supersededDocuments.length) {
        throw new ActionError(
          'Die Ausweissätze wurden parallel geändert. Bitte Seite neu laden und erneut versuchen.',
        );
      }

      await resolveNotificationsTx(tx, {
        tenantId: actor.tenantId,
        resources: supersededDocuments.map((entry) => ({
          resourceType: 'gwg_id_document',
          resourceId: entry.id,
        })),
      });
      await evidenceService.record(tx, {
        tenantId: actor.tenantId,
        actorType: 'STAFF',
        actorId: actor.staffId,
        action: 'gwg.id_document.make_current',
        resourceType: 'gwg_id_document_set',
        resourceId: data.documentSetId,
        before: { activeDocuments },
        after: {
          selectedDocumentSetId: data.documentSetId,
          supersededDocuments,
        },
      });
      return { reviewReset: check.status === 'IN_REVIEW' };
    },
  );
}
