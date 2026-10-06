'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx } from '@/server/auth/rbac';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  type StaffCtx,
} from '@/server/actions/staff-action';
import {
  DOCUMENT_BULK_MAX,
  INVALID_DOCUMENT_SELECTION,
  bulkActionError,
  bulkActionResult,
  clientAccessCheck,
  lockDocumentRows,
  revalidateDocumentLists,
  runDocumentBulk,
  type AssertClientAccess,
  type DocumentBulkResult,
} from '@/server/documents/document-bulk';
import { RETAG_CLASSIFICATIONS, retagDocument, retagDocuments } from '@/server/documents/retag';

export interface DocActionResult {
  ok: boolean;
  error?: string;
}

type StaffActor = Pick<StaffCtx, 'tenantId' | 'staffId'>;

const GWG_ASSOCIATED_VISIBILITY_ERROR =
  'Dieser Nachweis ist bereits einer GwG-Prüfung zugeordnet und unveränderlich. ' +
  'Ändern Sie die Zuordnung direkt in der GwG-Prüfung; für die endgültige Löschung ' +
  'verwenden Sie den vorgesehenen GwG-Vernichtungsprozess.';

/** P-18: Auswahl einer Bulk-Action (eine Action je Auswahl statt je Dokument). */
const DocumentIdsSchema = z.array(z.string().uuid()).min(1).max(DOCUMENT_BULK_MAX);

type LockedDocumentVisibility = {
  id: string;
  title: string;
  classification: string;
  clientId: string | null;
  deletedAt: Date | null;
  gwgDestroyedAt: Date | null;
};

/**
 * Sperrt zuerst ausschließlich die Dokumentzeile. Eine nachfolgende
 * Zuordnungsprüfung muss ein eigenes Statement sein: Falls FOR UPDATE auf
 * einen parallelen Zuordnungs-Commit warten musste, sieht erst dieses zweite
 * Statement unter READ COMMITTED den frisch committeten Zustand.
 */
async function lockDocumentVisibility(
  tx: TxClient,
  documentId: string,
  tenantId: string,
): Promise<LockedDocumentVisibility | null> {
  const rows = await tx.$queryRaw<LockedDocumentVisibility[]>`
    SELECT
      d.id,
      d.title,
      d.classification::text AS classification,
      d.client_id AS "clientId",
      d.deleted_at AS "deletedAt",
      d.gwg_destroyed_at AS "gwgDestroyedAt"
    FROM document d
    WHERE d.id = ${documentId}::uuid
      AND d.tenant_id = ${tenantId}::uuid
    FOR UPDATE OF d
  `;
  return rows[0] ?? null;
}

async function isDocumentLinkedToGwg(tx: TxClient, documentId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ linked: boolean }>>`
    SELECT EXISTS (
      SELECT 1
        FROM gwg_id_document gid
       WHERE gid.document_id = ${documentId}::uuid
    ) AS linked
  `;
  if (!rows[0]) throw new ActionError('GwG-Zuordnung des Dokuments konnte nicht geprüft werden.');
  return rows[0].linked;
}

const DeleteSchema = z.object({
  documentId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Soft-Delete eines Dokuments in der laufenden Transaktion (Einzel- und
 * Bulk-Action). Die Datei im Object-Store bleibt UNANGETASTET — GoBD liegt
 * unter COMPLIANCE-Lock; GwG-Nachweise werden im GOVERNANCE-Bucket durch den
 * separaten fachlichen Vernichtungsprozess behandelt.
 */
async function softDeleteDocumentTx(
  tx: TxClient,
  { tenantId, staffId }: StaffActor,
  assertAccess: AssertClientAccess,
  documentId: string,
  reason: string | null,
): Promise<{ clientId: string | null }> {
  // Expliziter Tenant-Filter plus Zeilensperre: GwG-Zuordnung und
  // Soft-Delete werden atomar gegeneinander serialisiert.
  const doc = await lockDocumentVisibility(tx, documentId, tenantId);
  if (!doc || doc.deletedAt) {
    throw new ActionError('Dokument nicht gefunden oder bereits gelöscht.');
  }
  // Vertraulich-/RESTRICTED-Ventil für Mandanten-Dokumente.
  if (doc.clientId) await assertAccess(doc.clientId);
  if (await isDocumentLinkedToGwg(tx, documentId)) {
    throw new ActionError(GWG_ASSOCIATED_VISIBILITY_ERROR);
  }
  await tx.document.update({
    where: { id: documentId },
    data: { deletedAt: new Date(), deletedByStaff: staffId, deleteReason: reason },
  });
  const unlinkedResearchResults = await tx.riskResearchResult.updateMany({
    where: { shelfDocumentId: documentId },
    data: { shelfDocumentId: null },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'document.delete',
    resourceType: 'document',
    resourceId: documentId,
    before: { title: doc.title, classification: doc.classification, deleted: false },
    after: { deleted: true, reason, unlinkedResearchResults: unlinkedResearchResults.count },
  });
  return { clientId: doc.clientId };
}

/**
 * Soft-Delete: blendet das Dokument aus den Listen aus. Bewusst kein
 * S3-DeleteObject: "Löschen" ist reine Sichtbarkeit, die Aufbewahrung erzwingt
 * der Object-Store. Wiederherstellbar via restoreDocumentAction.
 */
export async function softDeleteDocumentAction(
  input: z.infer<typeof DeleteSchema>,
): Promise<DocActionResult> {
  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId } = parsed.data;
  const reason = parsed.data.reason?.trim() || null;

  return withStaff(
    async (tx, staff) => {
      await softDeleteDocumentTx(
        tx,
        staff,
        clientAccessCheck(tx, staff.session),
        documentId,
        reason,
      );
    },
    { revalidate: '/staff/documents' },
  );
}

const BulkDeleteSchema = z.object({
  documentIds: DocumentIdsSchema,
  reason: z.string().trim().max(500).optional(),
});

/** P-18: Soft-Delete einer Auswahl mit einem Grund — eine Action, eine Transaktion. */
export async function softDeleteDocumentsAction(
  input: z.infer<typeof BulkDeleteSchema>,
): Promise<DocumentBulkResult> {
  const g = await staffActionGuard();
  if (!g.ok) return bulkActionError(g.error);
  const parsed = BulkDeleteSchema.safeParse(input);
  if (!parsed.success) return bulkActionError(INVALID_DOCUMENT_SELECTION);
  const reason = parsed.data.reason?.trim() || null;

  const outcome = await runDocumentBulk(
    g,
    parsed.data.documentIds.map((id) => ({ id })),
    (tx, { id }, assertAccess) => softDeleteDocumentTx(tx, g, assertAccess, id, reason),
    {
      component: 'document-bulk-delete',
      // Auch die verknüpften Recherche-Ergebnisse (Aktenregal) vor dem
      // Audit-Lock sperren — sie werden je Dokument entkoppelt.
      lockBlock: async (tx, block) => {
        await lockDocumentRows(tx, g.tenantId, block);
        await tx.$queryRaw`
          SELECT id
            FROM risk_research_result
           WHERE tenant_id = ${g.tenantId}::uuid
             AND shelf_document_id = ANY(${block.map(({ id }) => id)}::uuid[])
           ORDER BY id
             FOR UPDATE
        `;
      },
    },
  );
  if (outcome.done.length > 0) {
    revalidateDocumentLists(outcome.done.map(({ value }) => value.clientId));
  }
  return bulkActionResult(outcome.done.length, outcome.rejected);
}

const RestoreSchema = z.object({ documentId: z.string().uuid() });

export async function restoreDocumentAction(
  input: z.infer<typeof RestoreSchema>,
): Promise<DocActionResult> {
  const parsed = RestoreSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const doc = await lockDocumentVisibility(tx, documentId, tenantId);
      if (!doc || !doc.deletedAt) {
        throw new ActionError('Dokument nicht gefunden oder nicht gelöscht.');
      }
      if (doc.gwgDestroyedAt) {
        throw new ActionError(
          'Ein endgültig vernichteter GwG-Beleg darf nicht wiederhergestellt werden.',
        );
      }
      if (doc.clientId) await assertClientAccessTx(tx, session, doc.clientId);
      const restored = await tx.document.updateMany({
        where: { id: documentId, deletedAt: { not: null }, gwgDestroyedAt: null },
        data: { deletedAt: null, deletedByStaff: null, deleteReason: null },
      });
      if (restored.count !== 1) {
        throw new ActionError('Dokument konnte nicht wiederhergestellt werden.');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.restore',
        resourceType: 'document',
        resourceId: documentId,
        before: { deleted: true },
        after: { title: doc.title, deleted: false },
      });
    },
    { revalidate: '/staff/documents' },
  );
}

// ---------------------------------------------------------------------------
// Umklassifizierung (Retag): Schutzstufen-Logik, Sperren, journal-first
// Re-Store und Audit liegen im Service server/documents/retag.ts (K-03).
const ClassificationSchema = z.enum(RETAG_CLASSIFICATIONS);

const RetagSchema = z
  .object({
    documentId: z.string().uuid(),
    documentTypeId: z.string().uuid().optional(),
    classification: ClassificationSchema.optional(),
  })
  .refine((d) => d.documentTypeId || d.classification, {
    message: 'documentTypeId oder classification erforderlich',
  });

export async function retagDocumentAction(
  input: z.infer<typeof RetagSchema>,
): Promise<DocActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = RetagSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const result = await retagDocument(g, parsed.data.documentId, parsed.data);
  if (!result.ok) return result;
  // Unverändert (Ziel-Typ schon gesetzt): nichts geschrieben, nichts revalidiert.
  if (result.changed) {
    revalidatePath('/staff/documents');
    if (result.clientId) revalidatePath(`/staff/clients/${result.clientId}`);
  }
  return { ok: true };
}

const BulkRetagSchema = z
  .object({
    documentIds: DocumentIdsSchema,
    documentTypeId: z.string().uuid().optional(),
    classification: ClassificationSchema.optional(),
  })
  .refine((d) => d.documentTypeId || d.classification, {
    message: 'documentTypeId oder classification erforderlich',
  });

/**
 * P-18: Umklassifizierung einer Auswahl. Reine Metadatenänderungen laufen in
 * einer Transaktion; Höherstufungen laufen je Dokument journal-first im
 * Zeitbudget, die übrigen kommen als `pending` zurück (server/documents/retag.ts).
 */
export async function retagDocumentsAction(
  input: z.infer<typeof BulkRetagSchema>,
): Promise<DocumentBulkResult> {
  // Das Re-Store-Budget zählt ab Beginn der Action.
  const startedAt = Date.now();
  const g = await staffActionGuard();
  if (!g.ok) return bulkActionError(g.error);
  const parsed = BulkRetagSchema.safeParse(input);
  if (!parsed.success) return bulkActionError(INVALID_DOCUMENT_SELECTION);

  const outcome = await retagDocuments(g, parsed.data.documentIds, parsed.data, { startedAt });
  if (!outcome.ok) return bulkActionError(outcome.error);
  if (outcome.changedClients.length > 0) revalidateDocumentLists(outcome.changedClients);
  return bulkActionResult(outcome.done, outcome.rejected, outcome.pending);
}

const ShareSchema = z.object({
  documentId: z.string().uuid(),
  share: z.boolean(),
});

/**
 * Mandanten-Freigabe setzen/zurückziehen (Einzel- und Bulk-Action). Nur
 * Mandanten-Dokumente (client_id gesetzt) sind freigebbar — kanzlei-interne
 * Dateien haben keinen Portal-Empfänger. shared_with_client_at = NULL →
 * privat, gesetzt → im Mandantenportal sichtbar.
 */
async function setDocumentShareTx(
  tx: TxClient,
  { tenantId, staffId }: StaffActor,
  assertAccess: AssertClientAccess,
  documentId: string,
  share: boolean,
): Promise<{ clientId: string }> {
  const d = await tx.document.findFirst({
    where: { id: documentId, tenantId, deletedAt: null },
    select: { clientId: true, sharedWithClientAt: true },
  });
  if (!d) throw new ActionError('Dokument nicht gefunden.');
  if (!d.clientId) {
    throw new ActionError('Nur Mandanten-Dokumente können freigegeben werden.');
  }
  // Freigabe ans Portal ist besonders sensibel → Ventil zwingend.
  await assertAccess(d.clientId);
  await tx.document.update({
    where: { id: documentId },
    data: {
      sharedWithClientAt: share ? new Date() : null,
      sharedByStaff: share ? staffId : null,
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: share ? 'document.share' : 'document.unshare',
    resourceType: 'document',
    resourceId: documentId,
    before: { shared: d.sharedWithClientAt != null },
    after: { shared: share },
  });
  return { clientId: d.clientId };
}

export async function setDocumentShareAction(
  input: z.infer<typeof ShareSchema>,
): Promise<DocActionResult> {
  const parsed = ShareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId, share } = parsed.data;

  const r = await withStaff(async (tx, staff) =>
    setDocumentShareTx(tx, staff, clientAccessCheck(tx, staff.session), documentId, share),
  );

  if (!r.ok) return r;
  revalidatePath('/staff/documents');
  if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
  return { ok: true };
}

const BulkShareSchema = z.object({
  documentIds: DocumentIdsSchema,
  share: z.boolean(),
});

/** P-18: Freigabe/Entzug einer Auswahl — eine Action, eine Transaktion. */
export async function setDocumentsShareAction(
  input: z.infer<typeof BulkShareSchema>,
): Promise<DocumentBulkResult> {
  const g = await staffActionGuard();
  if (!g.ok) return bulkActionError(g.error);
  const parsed = BulkShareSchema.safeParse(input);
  if (!parsed.success) return bulkActionError(INVALID_DOCUMENT_SELECTION);
  const { share } = parsed.data;

  const outcome = await runDocumentBulk(
    g,
    parsed.data.documentIds.map((id) => ({ id })),
    (tx, { id }, assertAccess) => setDocumentShareTx(tx, g, assertAccess, id, share),
    {
      component: 'document-bulk-share',
      lockBlock: (tx, block) => lockDocumentRows(tx, g.tenantId, block),
    },
  );
  if (outcome.done.length > 0) {
    revalidateDocumentLists(outcome.done.map(({ value }) => value.clientId));
  }
  return bulkActionResult(outcome.done.length, outcome.rejected);
}
