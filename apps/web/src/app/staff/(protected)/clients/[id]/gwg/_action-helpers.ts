// =============================================================================
// Geteilte Helfer der GwG-Actions — genutzt von actions.ts (Pruefungs-
// Lebenszyklus), owner-actions.ts und id-document-actions.ts. Bewusst OHNE
// 'use server': reine Helfer, keine Actions. Der AST-Guard loest die
// auth-tragenden darunter (claimCheckMutation via withStaff-Aufrufer) ueber
// relative Importe auf.
// =============================================================================

import { type TxClient } from '@taxtronik/db';
import { gwgIdentityDocumentSetRevision } from '@/server/gwg/revisions';
import { ActionError, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';
import {
  assertGwgEditable,
  claimCheckMutation,
  type EditableGwgStatus,
} from '@/server/gwg/check-mutation';

// Prüfungs-Lebenszyklus (§ 8 GwG) liegt in server/gwg/check-mutation.ts, weil
// auch server/mandate-expansion ihn nutzt; die Actions importieren weiter von hier.
export { assertGwgEditable, claimCheckMutation };

// Einheitliches Action-Ergebnis aus der zentralen Quelle — der bestehende
// Import-Pfad './actions' bleibt für die Form-Komponenten stabil.
export type ActionResult = BaseActionResult;

export const PERSONAL_ID_TYPES = ['PERSONALAUSWEIS', 'REISEPASS'] as const;

export function isPersonalIdType(type: string): type is (typeof PERSONAL_ID_TYPES)[number] {
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

/** CAS-Prüfung für echte No-op-Saves, ohne eine laufende Freigabe zurückzusetzen. */
export async function confirmUnchangedCheck(
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
