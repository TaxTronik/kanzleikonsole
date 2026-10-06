// =============================================================================
// GwG: neue Revisionswerte entbestätigter Ausweissätze nach einer
// Personenmutation (vormals Helfer der GwG-Actions, Review-Befund K-03).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { gwgIdentityDocumentSetRevision } from './revisions';

export interface InvalidatedIdentitySet {
  documentSetId: string;
  revision: string;
}

/**
 * Liefert nach einer Personenmutation die neuen Revisionswerte der betroffenen
 * Ausweissaetze. Damit kann das UI die serverseitige Entbestaetigung sofort
 * abbilden und beim naechsten Speichern die korrekte CAS-Revision mitsenden,
 * ohne einen kompletten Seiten-Reload zu erzwingen.
 */
export async function invalidatedIdentitySetRevisions(
  tx: TxClient,
  checkId: string,
  affectedDocumentSetIds: string[],
): Promise<InvalidatedIdentitySet[]> {
  const documentSetIds = [...new Set(affectedDocumentSetIds)];
  if (documentSetIds.length === 0) return [];
  const documents = await tx.gwgIdDocument.findMany({
    where: {
      gwgCheckId: checkId,
      documentSetId: { in: documentSetIds },
      supersededAt: null,
    },
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
