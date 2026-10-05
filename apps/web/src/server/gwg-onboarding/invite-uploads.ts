import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

// =============================================================================
// Zuordnung Upload → GwG-Einladung (Review-Finding D-08)
//
// Einzige Quelle ist der Fremdschlüssel document.gwg_onboarding_invite_id. Der
// Uploadpfad setzt ihn schon beim Journal-Eintrag (Version PENDING) und
// finalisiert die Version (CLEAN) im selben Commit wie Audit und
// Einladungsstatus. Verwendbar ist ein Upload erst danach; genau diese Menge
// stand bisher zusätzlich in gwg_onboarding_invite.uploaded_document_ids.
//
// Die JSON-Liste wird nicht mehr gelesen. Upload, Verwerfen und Vernichtung
// pflegen sie nur weiter, damit ein App-Rollback auf das vorige Release
// funktioniert (Expand/Contract, docs/operations/release.md).
// =============================================================================

/** Finalisierter Upload; immer zusammen mit `gwgOnboardingInviteId` verwenden. */
export const FINALIZED_INVITE_UPLOAD = {
  versions: { some: { scanStatus: 'CLEAN' } },
} satisfies Prisma.DocumentWhereInput;

/** Auswahl für die Relation `GwgOnboardingInvite.uploadedDocuments`. */
export const FINALIZED_INVITE_UPLOAD_IDS = {
  where: FINALIZED_INVITE_UPLOAD,
  select: { id: true },
} satisfies Prisma.DocumentFindManyArgs;

export function inviteUploadIds(
  invite: { uploadedDocuments: ReadonlyArray<{ id: string }> } | null | undefined,
): string[] {
  return invite?.uploadedDocuments.map((document) => document.id) ?? [];
}

/**
 * Hochgeladene Unterlagen einer Einladung für die Kanzleiansicht. Vernichtete
 * Belege bleiben aus: Die Vernichtung einer GwG-Prüfung leert die JSON-Liste
 * ihrer Einladungen, die Ansicht zeigte danach keine Einträge; der
 * Fremdschlüssel bleibt dagegen auch an vernichteten Belegen stehen.
 */
export function loadInviteUploadedDocumentsTx(
  tx: TxClient,
  input: { clientId: string; inviteId: string },
) {
  return tx.document.findMany({
    where: {
      clientId: input.clientId,
      gwgOnboardingInviteId: input.inviteId,
      gwgDestroyedAt: null,
      ...FINALIZED_INVITE_UPLOAD,
    },
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}
