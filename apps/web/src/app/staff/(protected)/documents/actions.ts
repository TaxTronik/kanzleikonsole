'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  fetchObjectBytes,
  commitBytesWithTier,
  classificationToTier,
  type ProtectionTier,
} from '@taxtronik/storage';
import { carrierClassification } from '@/server/storage/document-type';

export interface DocActionResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Retagging — Schutzstufen-Logik (iter55: Stufe statt roher Klassifikation)
//
// Stufe steuert Bucket + Object-Lock + Aufbewahrung:
//   Rang 0: NONE  → kein Lock
//   Rang 1: GWG   → gwg-Bucket, COMPLIANCE 5 J.
//   Rang 2: GOBD  → gobd-Bucket, COMPLIANCE 10 J.
//
//  - neuer Rang  >  alter Rang → Re-Store (Bytes in korrekten Bucket
//    umkopieren, Version-Pointer + Retention aktualisieren).
//  - neuer Rang === alter Rang → reine Metadatenänderung.
//  - neuer Rang  <  alter Rang → BLOCKIERT (angewandte Aufbewahrung ist
//    nicht entfernbar; Bytes sind ohnehin Object-Lock-gehalten).
// ---------------------------------------------------------------------------
function tierRank(t: ProtectionTier): 0 | 1 | 2 {
  return t === 'GOBD' ? 2 : t === 'GWG' ? 1 : 0;
}

const DeleteSchema = z.object({
  documentId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Soft-Delete: blendet das Dokument aus den Listen aus. Die Datei im
 * Object-Store bleibt UNANGETASTET — GoBD/GwG-Objekte liegen unter
 * Object-Lock COMPLIANCE und sind ohnehin physisch nicht löschbar
 * (§ 147 AO / § 8 Abs. 4 GwG). Bewusst kein S3-DeleteObject hier:
 * "Löschen" ist reine Sichtbarkeit, die Aufbewahrung erzwingt der
 * Object-Store. Wiederherstellbar via restoreDocumentAction.
 */
export async function softDeleteDocumentAction(
  input: z.infer<typeof DeleteSchema>,
): Promise<DocActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { documentId } = parsed.data;
  const reason = parsed.data.reason?.trim() || null;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // Defense in Depth: expliziter Tenant-Filter zusätzlich zu RLS.
        const doc = await tx.document.findFirst({
          where: { id: documentId, tenantId, deletedAt: null },
          select: { id: true, title: true, classification: true },
        });
        if (!doc) throw new Error('Dokument nicht gefunden oder bereits gelöscht.');
        await tx.document.update({
          where: { id: documentId },
          data: { deletedAt: new Date(), deletedByStaff: staffId, deleteReason: reason },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'document.delete',
          resourceType: 'document',
          resourceId: documentId,
          before: { title: doc.title, classification: doc.classification, deleted: false },
          after: { deleted: true, reason },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/documents');
  return { ok: true };
}

const RestoreSchema = z.object({ documentId: z.string().uuid() });

export async function restoreDocumentAction(
  input: z.infer<typeof RestoreSchema>,
): Promise<DocActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = RestoreSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { documentId } = parsed.data;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const doc = await tx.document.findFirst({
          where: { id: documentId, tenantId, deletedAt: { not: null } },
          select: { id: true, title: true },
        });
        if (!doc) throw new Error('Dokument nicht gefunden oder nicht gelöscht.');
        await tx.document.update({
          where: { id: documentId },
          data: { deletedAt: null, deletedByStaff: null, deleteReason: null },
        });
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
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/documents');
  return { ok: true };
}

const RetagSchema = z
  .object({
    documentId: z.string().uuid(),
    documentTypeId: z.string().uuid().optional(),
    classification: z
      .enum(['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX', 'GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE', 'GENERAL'])
      .optional(),
  })
  .refine((d) => d.documentTypeId || d.classification, {
    message: 'documentTypeId oder classification erforderlich',
  });

export async function retagDocumentAction(
  input: z.infer<typeof RetagSchema>,
): Promise<DocActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = RetagSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { documentId } = parsed.data;

  // 1. Dokument + aktuellen Typ + neueste Version laden, parallel das
  //    Ziel auflösen (Stufe + Carrier-Klassifikation + Typ-ID).
  let ctx:
    | {
        oldTier: ProtectionTier;
        oldTypeId: string | null;
        oldClassification: string;
        clientId: string | null;
        versionId: string;
        bucket: string;
        key: string;
        newTier: ProtectionTier;
        newTypeId: string | null;
        newClassification: string;
      }
    | null = null;
  try {
    ctx = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const d = await tx.document.findFirst({
          where: { id: documentId, tenantId, deletedAt: null },
          select: {
            classification: true,
            documentTypeId: true,
            clientId: true,
            documentType: { select: { tier: true } },
            versions: {
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { id: true, storageBucket: true, storageKey: true },
            },
          },
        });
        if (!d || !d.versions[0]) return null;

        let newTier: ProtectionTier;
        let newTypeId: string | null;
        let newClassification: string;
        if (parsed.data.documentTypeId) {
          const t = await tx.documentType.findFirst({
            where: { id: parsed.data.documentTypeId, tenantId, active: true },
            select: { id: true, tier: true, classificationKey: true },
          });
          if (!t) throw new Error('Datei-Typ nicht gefunden.');
          newTier = t.tier as ProtectionTier;
          newTypeId = t.id;
          newClassification = carrierClassification(t.tier as ProtectionTier, t.classificationKey);
        } else {
          const cls = parsed.data.classification!;
          const builtin = await tx.documentType.findFirst({
            where: { tenantId, classificationKey: cls },
            select: { id: true },
          });
          newTier = classificationToTier(cls);
          newTypeId = builtin?.id ?? null;
          newClassification = cls;
        }

        return {
          oldTier: (d.documentType?.tier as ProtectionTier | undefined) ??
            classificationToTier(d.classification),
          oldTypeId: d.documentTypeId,
          oldClassification: d.classification,
          clientId: d.clientId,
          versionId: d.versions[0].id,
          bucket: d.versions[0].storageBucket,
          key: d.versions[0].storageKey,
          newTier,
          newTypeId,
          newClassification,
        };
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!ctx) return { ok: false, error: 'Dokument oder Version nicht gefunden.' };

  if (ctx.newTypeId && ctx.newTypeId === ctx.oldTypeId) return { ok: true }; // No-op.

  const oldR = tierRank(ctx.oldTier);
  const newR = tierRank(ctx.newTier);

  if (newR < oldR) {
    return {
      ok: false,
      error:
        'Herabstufung nicht möglich: Die gesetzliche Aufbewahrung (Object-Lock) ' +
        'lässt sich nicht entfernen. GoBD/GwG kann nicht auf eine schwächere ' +
        'Stufe zurückgesetzt werden.',
    };
  }

  try {
    if (newR === oldR) {
      // Gleiche Stufe → reine Metadatenänderung (Bucket/Lock bleiben).
      await withTenantContext(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        async (tx) => {
          await tx.document.update({
            where: { id: documentId },
            data: {
              classification: ctx!.newClassification as never,
              documentTypeId: ctx!.newTypeId,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'document.retag',
            resourceType: 'document',
            resourceId: documentId,
            before: { classification: ctx!.oldClassification, tier: ctx!.oldTier },
            after: { classification: ctx!.newClassification, tier: ctx!.newTier, reStored: false },
          });
        },
      );
    } else {
      // Höherstufung → Re-Store: Bytes holen und tier-getrieben mit
      // Object-Lock + Retention neu schreiben. Storage AUSSERHALB der DB-Tx.
      const bytes = await fetchObjectBytes(ctx.bucket, ctx.key);
      const commit = await commitBytesWithTier({
        fileData: bytes,
        tier: ctx.newTier,
        tenantId,
      });
      await withTenantContext(
        { tenantId, actorId: staffId, actorType: 'STAFF' },
        async (tx) => {
          await tx.documentVersion.update({
            where: { id: ctx!.versionId },
            data: {
              storageBucket: commit.targetBucket,
              storageKey: commit.targetKey,
              immutable: commit.immutable,
              sha256: commit.sha256,
              sizeBytes: commit.sizeBytes,
            },
          });
          await tx.document.update({
            where: { id: documentId },
            data: {
              classification: ctx!.newClassification as never,
              documentTypeId: ctx!.newTypeId,
              retentionUntil: commit.retentionUntil,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'document.retag',
            resourceType: 'document',
            resourceId: documentId,
            before: { classification: ctx!.oldClassification, tier: ctx!.oldTier },
            after: {
              classification: ctx!.newClassification,
              tier: ctx!.newTier,
              reStored: true,
              storageBucket: commit.targetBucket,
            },
          });
        },
      );
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('INFECTED')) {
      return { ok: false, error: 'Datei als infiziert markiert — Retag abgebrochen.' };
    }
    if (msg.startsWith('SCAN_ERROR')) {
      return { ok: false, error: 'Virus-Scan fehlgeschlagen — Retag abgebrochen.' };
    }
    return { ok: false, error: msg };
  }

  revalidatePath('/staff/documents');
  if (ctx.clientId) revalidatePath(`/staff/clients/${ctx.clientId}`);
  return { ok: true };
}

const ShareSchema = z.object({
  documentId: z.string().uuid(),
  share: z.boolean(),
});

/**
 * Mandanten-Freigabe setzen/zurückziehen. Nur Mandanten-Dokumente
 * (client_id gesetzt) sind freigebbar — kanzlei-interne Dateien haben
 * keinen Portal-Empfänger. shared_with_client_at = NULL → privat,
 * gesetzt → im Mandantenportal sichtbar.
 */
export async function setDocumentShareAction(
  input: z.infer<typeof ShareSchema>,
): Promise<DocActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = ShareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { documentId, share } = parsed.data;

  try {
    const clientId = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const d = await tx.document.findFirst({
          where: { id: documentId, tenantId, deletedAt: null },
          select: { clientId: true, sharedWithClientAt: true },
        });
        if (!d) throw new Error('Dokument nicht gefunden.');
        if (!d.clientId) {
          throw new Error('Nur Mandanten-Dokumente können freigegeben werden.');
        }
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
        return d.clientId;
      },
    );
    revalidatePath('/staff/documents');
    if (clientId) revalidatePath(`/staff/clients/${clientId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
