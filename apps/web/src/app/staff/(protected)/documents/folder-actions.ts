'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { toActionError } from '@/server/auth/rbac';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

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
    const id = await withTenantContext(
      ctx,
      async (tx) => {
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
      },
    );
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
    const clientId = await withTenantContext(
      ctx,
      async (tx) => {
        const f = await tx.documentFolder.findFirst({
          where: { id: folderId, tenantId },
          select: { name: true, clientId: true },
        });
        if (!f) throw new ActionError('Ordner nicht gefunden.');
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
      },
    );
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
    const clientId = await withTenantContext(
      ctx,
      async (tx) => {
        const f = await tx.documentFolder.findFirst({
          where: { id: folderId, tenantId },
          select: { name: true, parentId: true, clientId: true },
        });
        if (!f) throw new ActionError('Ordner nicht gefunden.');
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
      },
    );
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

export async function moveFolderAction(
  input: z.infer<typeof MoveSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = MoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId, ctx } = g;
  const { folderId, newParentId } = parsed.data;
  if (folderId === newParentId) return { ok: false, error: 'Ordner kann nicht in sich selbst.' };

  try {
    const clientId = await withTenantContext(
      ctx,
      async (tx) => {
        const f = await tx.documentFolder.findFirst({
          where: { id: folderId, tenantId },
          select: { clientId: true, parentId: true },
        });
        if (!f) throw new ActionError('Ordner nicht gefunden.');

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
            const up: { parentId: string | null } | null =
              await tx.documentFolder.findFirst({
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
        return f.clientId;
      },
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

export async function setDocumentFolderAction(
  input: z.infer<typeof SetDocSchema>,
): Promise<FolderActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = SetDocSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId, ctx } = g;
  const { documentId, folderId } = parsed.data;

  try {
    const clientId = await withTenantContext(
      ctx,
      async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id: documentId, tenantId, deletedAt: null },
          select: { clientId: true, folderId: true },
        });
        if (!doc) throw new ActionError('Dokument nicht gefunden.');
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
        return doc.clientId;
      },
    );
    revalidate(clientId);
    return { ok: true };
  } catch (e) {
    return mapFolderError(e);
  }
}

function mapFolderError(e: unknown): FolderActionResult {
  // Unique-Index-Verletzung (gleicher Ordnername auf einer Ebene) → verständliche
  // Meldung. P2002-Code ODER der konkrete Constraint-/Prisma-Text.
  const code = (e as { code?: string }).code;
  const msg = (e as Error)?.message ?? '';
  if (code === 'P2002' || msg.includes('document_folder_level_name_uniq') || msg.includes('Unique constraint')) {
    return { ok: false, error: 'Auf dieser Ebene gibt es bereits einen Ordner mit diesem Namen.' };
  }
  // Domänen-Fehler (ActionError) reicht toActionError UI-sicher durch; alles
  // andere wird generisch — kein Leak roher Prisma-Internals mehr.
  return toActionError(e);
}
