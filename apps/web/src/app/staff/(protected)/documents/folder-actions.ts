'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
import { staffActionGuard, ActionError, type StaffCtx } from '@/server/actions/staff-action';
import { isUniqueViolation } from '@/server/actions/database-error';
import {
  DOCUMENT_BULK_MAX,
  INVALID_DOCUMENT_SELECTION,
  bulkActionError,
  bulkActionResult,
  clientAccessCheck,
  lockDocumentRows,
  lockFolderRows,
  revalidateDocumentLists,
  runDocumentBulk,
  type AssertClientAccess,
  type DocumentBulkResult,
} from '@/server/documents/document-bulk';

export interface FolderActionResult {
  ok: boolean;
  error?: string;
  folderId?: string;
}

const NAME = z.string().trim().min(1, 'Name fehlt.').max(120);

function revalidate(clientId: string | null) {
  revalidatePath('/staff/documents');
  if (clientId) revalidatePath(`/staff/clients/${clientId}`);
}

// ---------------------------------------------------------------------------
// Ordner anlegen
// ---------------------------------------------------------------------------
const CreateSchema = z.object({
  clientId: z.string().uuid().nullable(),
  parentId: z.string().uuid().nullable(),
  name: NAME,
});

export async function createFolderAction(
  input: z.infer<typeof CreateSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  const { tenantId, staffId, ctx } = g;
  const { parentId } = parsed.data;
  const name = parsed.data.name.trim();

  try {
    const id = await withTenantContext(ctx, async (tx) => {
      // clientId aus dem Parent ableiten (ein Unterordner liegt zwingend
      // im selben Bereich wie sein Parent) — sonst der übergebene Wert.
      let clientId = parsed.data.clientId;
      if (parentId) {
        const parent = await tx.documentFolder.findFirst({
          where: { id: parentId, tenantId },
          select: { clientId: true },
        });
        if (!parent) throw new ActionError('Übergeordneter Ordner nicht gefunden.');
        clientId = parent.clientId;
      }
      if (clientId) await assertClientAccessTx(tx, g.session, clientId);
      const folder = await tx.documentFolder.create({
        data: { tenantId, clientId, parentId, name, createdByStaff: staffId },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document_folder.create',
        resourceType: 'document_folder',
        resourceId: folder.id,
        after: { name, clientId, parentId },
      });
      return folder.id;
    });
    revalidate(parsed.data.clientId);
    return { ok: true, folderId: id };
  } catch (e) {
    return mapFolderError(e);
  }
}

// ---------------------------------------------------------------------------
// Ordner umbenennen
// ---------------------------------------------------------------------------
const RenameSchema = z.object({ folderId: z.string().uuid(), name: NAME });

export async function renameFolderAction(
  input: z.infer<typeof RenameSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = RenameSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  const { tenantId, staffId, ctx } = g;
  const { folderId } = parsed.data;
  const name = parsed.data.name.trim();

  try {
    const clientId = await withTenantContext(ctx, async (tx) => {
      const f = await tx.documentFolder.findFirst({
        where: { id: folderId, tenantId },
        select: { name: true, clientId: true },
      });
      if (!f) throw new ActionError('Ordner nicht gefunden.');
      if (f.clientId) await assertClientAccessTx(tx, g.session, f.clientId);
      await tx.documentFolder.update({ where: { id: folderId }, data: { name } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document_folder.rename',
        resourceType: 'document_folder',
        resourceId: folderId,
        before: { name: f.name },
        after: { name },
      });
      return f.clientId;
    });
    revalidate(clientId);
    return { ok: true };
  } catch (e) {
    return mapFolderError(e);
  }
}

// ---------------------------------------------------------------------------
// Ordner löschen — Inhalte (Unterordner + Dokumente) wandern in den Parent.
// Es wird NIE ein Dokument gelöscht (Aufbewahrungspflicht).
// ---------------------------------------------------------------------------
const DeleteSchema = z.object({ folderId: z.string().uuid() });

export async function deleteFolderAction(
  input: z.infer<typeof DeleteSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId, ctx } = g;
  const { folderId } = parsed.data;

  try {
    const clientId = await withTenantContext(ctx, async (tx) => {
      const f = await tx.documentFolder.findFirst({
        where: { id: folderId, tenantId },
        select: { name: true, parentId: true, clientId: true },
      });
      if (!f) throw new ActionError('Ordner nicht gefunden.');
      if (f.clientId) await assertClientAccessTx(tx, g.session, f.clientId);
      // Inhalte in den Parent reparentieren — Dokumente bleiben erhalten.
      await tx.document.updateMany({
        where: { folderId, tenantId },
        data: { folderId: f.parentId },
      });
      await tx.documentFolder.updateMany({
        where: { parentId: folderId, tenantId },
        data: { parentId: f.parentId },
      });
      await tx.documentFolder.delete({ where: { id: folderId } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document_folder.delete',
        resourceType: 'document_folder',
        resourceId: folderId,
        before: { name: f.name, parentId: f.parentId, clientId: f.clientId },
        after: { reparentedTo: f.parentId },
      });
      return f.clientId;
    });
    revalidate(clientId);
    return { ok: true };
  } catch (e) {
    return mapFolderError(e);
  }
}

// ---------------------------------------------------------------------------
// Ordner verschieben (reparentieren) — zyklensicher.
// ---------------------------------------------------------------------------
const MoveSchema = z.object({
  folderId: z.string().uuid(),
  newParentId: z.string().uuid().nullable(),
});

type StaffActor = Pick<StaffCtx, 'tenantId' | 'staffId'>;

/** Ordner in der laufenden Transaktion reparentieren (Einzel- und Bulk-Action). */
async function moveFolderTx(
  tx: TxClient,
  { tenantId, staffId }: StaffActor,
  assertAccess: AssertClientAccess,
  folderId: string,
  newParentId: string | null,
): Promise<{ clientId: string | null }> {
  if (folderId === newParentId) throw new ActionError('Ordner kann nicht in sich selbst.');
  const f = await tx.documentFolder.findFirst({
    where: { id: folderId, tenantId },
    select: { clientId: true, parentId: true },
  });
  if (!f) throw new ActionError('Ordner nicht gefunden.');
  if (f.clientId) await assertAccess(f.clientId);

  if (newParentId) {
    const np = await tx.documentFolder.findFirst({
      where: { id: newParentId, tenantId },
      select: { clientId: true },
    });
    if (!np) throw new ActionError('Zielordner nicht gefunden.');
    if (np.clientId !== f.clientId) {
      throw new ActionError('Verschieben über Mandanten-/Bereichsgrenzen nicht erlaubt.');
    }
    // Zyklus verhindern: von newParent nach oben laufen; trifft man
    // folderId, läge der Ordner in seinem eigenen Teilbaum.
    let cursor: string | null = newParentId;
    let guard = 0;
    while (cursor && guard++ < 1000) {
      if (cursor === folderId) {
        throw new ActionError('Zielordner liegt im eigenen Unterbaum.');
      }
      const up: { parentId: string | null } | null = await tx.documentFolder.findFirst({
        where: { id: cursor, tenantId },
        select: { parentId: true },
      });
      cursor = up?.parentId ?? null;
    }
  }

  await tx.documentFolder.update({
    where: { id: folderId },
    data: { parentId: newParentId },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'document_folder.move',
    resourceType: 'document_folder',
    resourceId: folderId,
    before: { parentId: f.parentId },
    after: { parentId: newParentId },
  });
  return { clientId: f.clientId };
}

export async function moveFolderAction(
  input: z.infer<typeof MoveSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = MoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { ctx } = g;
  const { folderId, newParentId } = parsed.data;
  if (folderId === newParentId) return { ok: false, error: 'Ordner kann nicht in sich selbst.' };

  try {
    const { clientId } = await withTenantContext(ctx, (tx) =>
      moveFolderTx(tx, g, clientAccessCheck(tx, g.session), folderId, newParentId),
    );
    revalidate(clientId);
    return { ok: true };
  } catch (e) {
    return mapFolderError(e);
  }
}

// ---------------------------------------------------------------------------
// Dokument einem Ordner zuordnen (oder herauslösen: folderId = null).
// ---------------------------------------------------------------------------
const SetDocSchema = z.object({
  documentId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
});

/** Dokument in der laufenden Transaktion einem Ordner zuordnen (Einzel- und Bulk-Action). */
async function setDocumentFolderTx(
  tx: TxClient,
  { tenantId, staffId }: StaffActor,
  assertAccess: AssertClientAccess,
  documentId: string,
  folderId: string | null,
): Promise<{ clientId: string | null }> {
  const doc = await tx.document.findFirst({
    where: { id: documentId, tenantId, deletedAt: null },
    select: { clientId: true, folderId: true },
  });
  if (!doc) throw new ActionError('Dokument nicht gefunden.');
  if (doc.clientId) await assertAccess(doc.clientId);
  if (folderId) {
    const folder = await tx.documentFolder.findFirst({
      where: { id: folderId, tenantId },
      select: { clientId: true },
    });
    if (!folder) throw new ActionError('Ordner nicht gefunden.');
    // Ein Ordner gehört zu einem Mandanten (oder kanzlei-intern).
    // Ein Dokument darf nur in einen Ordner desselben Bereichs.
    if ((folder.clientId ?? null) !== (doc.clientId ?? null)) {
      throw new ActionError('Ordner gehört zu einem anderen Mandanten/Bereich.');
    }
  }
  await tx.document.update({
    where: { id: documentId },
    data: { folderId },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'document.move_folder',
    resourceType: 'document',
    resourceId: documentId,
    before: { folderId: doc.folderId },
    after: { folderId },
  });
  return { clientId: doc.clientId };
}

export async function setDocumentFolderAction(
  input: z.infer<typeof SetDocSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = SetDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { ctx } = g;
  const { documentId, folderId } = parsed.data;

  try {
    const { clientId } = await withTenantContext(ctx, (tx) =>
      setDocumentFolderTx(tx, g, clientAccessCheck(tx, g.session), documentId, folderId),
    );
    revalidate(clientId);
    return { ok: true };
  } catch (e) {
    return mapFolderError(e);
  }
}

// ---------------------------------------------------------------------------
// P-18: Auswahl (Dokumente und Ordner) in einen Zielordner verschieben — eine
// Action, eine Transaktion, je Eintrag Zugriffsprüfung und Audit wie oben.
// ---------------------------------------------------------------------------
const BulkMoveSchema = z
  .object({
    documentIds: z.array(z.string().uuid()).max(DOCUMENT_BULK_MAX),
    folderIds: z.array(z.string().uuid()).max(DOCUMENT_BULK_MAX),
    targetFolderId: z.string().uuid().nullable(),
  })
  .refine((d) => {
    const count = d.documentIds.length + d.folderIds.length;
    return count > 0 && count <= DOCUMENT_BULK_MAX;
  });

export async function moveDocumentItemsAction(
  input: z.infer<typeof BulkMoveSchema>,
): Promise<DocumentBulkResult> {
  const g = await staffActionGuard();
  if (!g.ok) return bulkActionError(g.error);
  const parsed = BulkMoveSchema.safeParse(input);
  if (!parsed.success) return bulkActionError(INVALID_DOCUMENT_SELECTION);
  const { targetFolderId } = parsed.data;
  const items = [
    ...parsed.data.folderIds.map((id) => ({ id, kind: 'folder' as const })),
    ...parsed.data.documentIds.map((id) => ({ id, kind: 'document' as const })),
  ];

  const outcome = await runDocumentBulk(
    g,
    items,
    (tx, item, assertAccess) =>
      item.kind === 'folder'
        ? moveFolderTx(tx, g, assertAccess, item.id, targetFolderId)
        : setDocumentFolderTx(tx, g, assertAccess, item.id, targetFolderId),
    {
      component: 'document-bulk-move',
      errorMessage: (error) => mapFolderError(error).error ?? 'Fehler.',
      // Dokumente vor Ordnern — dieselbe Reihenfolge wie deleteFolderAction.
      // Den Zielordner hält der Fremdschlüssel ohnehin per KEY SHARE; die
      // Sperre wird hier vor dem Audit-Lock genommen statt erst beim Update.
      lockBlock: async (tx, block) => {
        await lockDocumentRows(
          tx,
          g.tenantId,
          block.filter((item) => item.kind === 'document'),
        );
        await lockFolderRows(
          tx,
          g.tenantId,
          block.filter((item) => item.kind === 'folder'),
        );
        if (targetFolderId) {
          await tx.$queryRaw`
            SELECT id
              FROM document_folder
             WHERE tenant_id = ${g.tenantId}::uuid
               AND id = ${targetFolderId}::uuid
               FOR KEY SHARE
          `;
        }
      },
    },
  );
  if (outcome.done.length > 0) {
    revalidateDocumentLists(outcome.done.map(({ value }) => value.clientId));
  }
  return bulkActionResult(outcome.done.length, outcome.rejected);
}

function mapFolderError(e: unknown): FolderActionResult {
  // Unique-Index-Verletzung (gleicher Ordnername auf einer Ebene) → verständliche
  // Meldung. Eingeordnet über P2002 bzw. SQLSTATE 23505 (F-03), nicht über Text.
  if (isUniqueViolation(e)) {
    return { ok: false, error: 'Auf dieser Ebene gibt es bereits einen Ordner mit diesem Namen.' };
  }
  // Domänen-Fehler (ActionError) reicht toActionError UI-sicher durch; alles
  // andere wird generisch — kein Leak roher Prisma-Internals mehr.
  return toActionError(e);
}
