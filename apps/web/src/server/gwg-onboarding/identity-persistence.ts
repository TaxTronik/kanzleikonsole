import { randomUUID } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';

export class OnboardingIdentitySetConflictError extends Error {}

export interface ExistingOnboardingDocument {
  id: string;
  documentId: string | null;
  documentSetId: string;
  type: string;
}

export interface OnboardingIdentitySetInput {
  documentIds: readonly [string, string];
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  ownerName: string;
  number: string | null;
  issuedBy: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  beneficialOwnerSubjectId?: string | null;
  representativeSubjectId?: string | null;
  notePrefix?: string;
}

export async function persistOnboardingIdentitySetTx(
  tx: TxClient,
  checkId: string,
  existingDocumentById: ReadonlyMap<string, ExistingOnboardingDocument>,
  input: OnboardingIdentitySetInput,
): Promise<void> {
  const existingRows = input.documentIds.flatMap((documentId) => {
    const row = existingDocumentById.get(documentId);
    return row && (row.type === 'PERSONALAUSWEIS' || row.type === 'REISEPASS') ? [row] : [];
  });
  if (new Set(existingRows.map((entry) => entry.documentSetId)).size > 1) {
    throw new OnboardingIdentitySetConflictError();
  }
  if (existingRows.some((entry) => entry.type !== input.type)) {
    throw new OnboardingIdentitySetConflictError();
  }

  const documentSetId = existingRows[0]?.documentSetId ?? randomUUID();
  const missingRows = [];
  for (const [side, documentId] of input.documentIds.entries()) {
    const data = {
      gwgCheckId: checkId,
      documentSetId,
      type: input.type,
      ownerName: input.ownerName,
      documentId,
      number: input.number,
      issuedBy: input.issuedBy,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate,
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: input.beneficialOwnerSubjectId ?? null,
      representativeSubjectId: input.representativeSubjectId ?? null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
      verifiedAt: null,
    };
    const notes = input.notePrefix
      ? `${input.notePrefix} – ${side === 0 ? 'Vorderseite' : 'Rückseite'} (durch Mandant hochgeladen)`
      : side === 0
        ? 'Vorderseite (durch Mandant hochgeladen)'
        : 'Rückseite (durch Mandant hochgeladen)';
    const existing = existingDocumentById.get(documentId);
    if (existing && (existing.type === 'PERSONALAUSWEIS' || existing.type === 'REISEPASS')) {
      const updated = await tx.gwgIdDocument.updateMany({
        where: { id: existing.id, gwgCheckId: checkId, documentId },
        data,
      });
      if (updated.count !== 1) throw new OnboardingIdentitySetConflictError();
    } else {
      missingRows.push({ ...data, notes });
    }
  }
  if (missingRows.length > 0) await tx.gwgIdDocument.createMany({ data: missingRows });
}
