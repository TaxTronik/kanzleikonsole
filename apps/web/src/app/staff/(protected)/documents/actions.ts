'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import {
  fetchObjectBytes,
  commitBytesWithTier,
  classificationToTier,
  gobdRetentionYears,
  type ProtectionTier,
} from '@taxtronik/storage';
import { carrierClassification } from '@/server/storage/document-type';
import { documentRetagDecision } from '@/server/storage/retag-policy';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard, withStaff, ActionError } from '@/server/actions/staff-action';

export interface DocActionResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Retagging — Schutzstufen-Logik (iter55: Stufe statt roher Klassifikation)
//
// Stufe steuert Bucket + Object-Lock + Aufbewahrung:
//   Rang 0: NONE  → kein Lock
//   Rang 1: GWG   → gwg-Bucket, GOVERNANCE; fachliche Löschung über Queue
//   Rang 2: GOBD  → gobd-Bucket, COMPLIANCE 6/8/10 J. je Datei-Typ
//
//  - neuer Rang  >  alter Rang → Re-Store (Bytes in korrekten Bucket
//    umkopieren, Version-Pointer + Retention aktualisieren).
//  - gleicher GOBD-Rang, längere Frist → Re-Store mit verlängertem Lock.
//  - gleicher GOBD-Rang, kürzere Frist → blockiert (bestehender Lock bleibt).
//  - sonst gleicher Rang → reine Metadatenänderung.
//  - neuer Rang  <  alter Rang → BLOCKIERT (angewandte Aufbewahrung ist
//    nicht entfernbar; Bytes sind ohnehin Object-Lock-gehalten).
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
  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId } = parsed.data;
  const reason = parsed.data.reason?.trim() || null;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // Defense in Depth: expliziter Tenant-Filter zusätzlich zu RLS.
      const doc = await tx.document.findFirst({
        where: { id: documentId, tenantId, deletedAt: null },
        select: { id: true, title: true, classification: true, clientId: true },
      });
      if (!doc) throw new ActionError('Dokument nicht gefunden oder bereits gelöscht.');
      // Vertraulich-/RESTRICTED-Ventil für Mandanten-Dokumente.
      if (doc.clientId) await assertClientAccessTx(tx, session, doc.clientId);
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
    { revalidate: '/staff/documents' },
  );
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
      const doc = await tx.document.findFirst({
        where: { id: documentId, tenantId, deletedAt: { not: null } },
        select: { id: true, title: true, clientId: true, gwgDestroyedAt: true },
      });
      if (!doc) throw new ActionError('Dokument nicht gefunden oder nicht gelöscht.');
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

const RetagSchema = z
  .object({
    documentId: z.string().uuid(),
    documentTypeId: z.string().uuid().optional(),
    classification: z
      .enum([
        'GOBD_INVOICE',
        'GOBD_CONTRACT',
        'GOBD_TAX',
        'GWG_EVIDENCE',
        'PERSONNEL',
        'STAFF_PRIVATE',
        'GENERAL',
      ])
      .optional(),
  })
  .refine((d) => d.documentTypeId || d.classification, {
    message: 'documentTypeId oder classification erforderlich',
  });

export async function retagDocumentAction(
  input: z.infer<typeof RetagSchema>,
): Promise<DocActionResult> {
  // Mehrstufig (DB-Tx ↔ Storage ↔ DB-Tx) + Sonderfehler (INFECTED/SCAN) →
  // nur das Gate zentralisieren, die Tx-Choreografie bleibt manuell.
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId } = g;
  const parsed = RetagSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId } = parsed.data;

  // 1. Dokument + aktuellen Typ + neueste Version laden, parallel das
  //    Ziel auflösen (Stufe + Carrier-Klassifikation + Typ-ID).
  let ctx: {
    oldTier: ProtectionTier;
    oldTypeId: string | null;
    oldClassification: string;
    clientId: string | null;
    versionId: string;
    bucket: string;
    key: string;
    createdAt: Date;
    oldRetentionYears: number | null;
    newTier: ProtectionTier;
    newTypeId: string | null;
    newClassification: string;
    newRetentionYears: number | null;
  } | null = null;
  try {
    ctx = await withTenantContext(g.ctx, async (tx) => {
      const d = await tx.document.findFirst({
        where: { id: documentId, tenantId, deletedAt: null },
        select: {
          classification: true,
          documentTypeId: true,
          clientId: true,
          createdAt: true,
          documentType: { select: { tier: true, retentionYears: true } },
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
            select: { id: true, storageBucket: true, storageKey: true },
          },
        },
      });
      if (!d || !d.versions[0]) return null;
      // Vertraulich-/RESTRICTED-Ventil (ForbiddenError wird unten via
      // toActionError gemappt).
      if (d.clientId) await assertClientAccessTx(tx, g.session, d.clientId);

      let newTier: ProtectionTier;
      let newTypeId: string | null;
      let newClassification: string;
      let newRetentionYears: number | null;
      if (parsed.data.documentTypeId) {
        const t = await tx.documentType.findFirst({
          where: { id: parsed.data.documentTypeId, tenantId, active: true },
          select: { id: true, tier: true, classificationKey: true, retentionYears: true },
        });
        if (!t) throw new ActionError('Datei-Typ nicht gefunden.');
        newTier = t.tier as ProtectionTier;
        newTypeId = t.id;
        newClassification = carrierClassification(t.tier as ProtectionTier, t.classificationKey);
        newRetentionYears = t.retentionYears;
      } else {
        const cls = parsed.data.classification!;
        const builtin = await tx.documentType.findFirst({
          where: { tenantId, classificationKey: cls },
          select: { id: true },
        });
        newTier = classificationToTier(cls);
        newTypeId = builtin?.id ?? null;
        newClassification = cls;
        newRetentionYears =
          newTier === 'GOBD' ? gobdRetentionYears(cls) : newTier === 'GWG' ? 5 : null;
      }

      return {
        oldTier:
          (d.documentType?.tier as ProtectionTier | undefined) ??
          classificationToTier(d.classification),
        oldTypeId: d.documentTypeId,
        oldClassification: d.classification,
        clientId: d.clientId,
        versionId: d.versions[0].id,
        bucket: d.versions[0].storageBucket,
        key: d.versions[0].storageKey,
        createdAt: d.createdAt,
        oldRetentionYears:
          d.documentType?.retentionYears ??
          ((d.documentType?.tier ?? classificationToTier(d.classification)) === 'GOBD'
            ? gobdRetentionYears(d.classification)
            : (d.documentType?.tier ?? classificationToTier(d.classification)) === 'GWG'
              ? 5
              : null),
        newTier,
        newTypeId,
        newClassification,
        newRetentionYears,
      };
    });
  } catch (e) {
    return toActionError(e);
  }
  if (!ctx) return { ok: false, error: 'Dokument oder Version nicht gefunden.' };

  if (ctx.newTypeId && ctx.newTypeId === ctx.oldTypeId) return { ok: true }; // No-op.

  const retagDecision = documentRetagDecision({
    oldTier: ctx.oldTier,
    newTier: ctx.newTier,
    oldRetentionYears: ctx.oldRetentionYears,
    newRetentionYears: ctx.newRetentionYears,
  });

  if (retagDecision === 'BLOCK_TIER_DOWNGRADE') {
    return {
      ok: false,
      error:
        'Herabstufung nicht möglich: Die gesetzliche Aufbewahrung (Object-Lock) ' +
        'lässt sich nicht entfernen. GoBD/GwG kann nicht auf eine schwächere ' +
        'Stufe zurückgesetzt werden.',
    };
  }

  if (retagDecision === 'BLOCK_RETENTION_SHORTENING') {
    return {
      ok: false,
      error:
        'Kürzere Aufbewahrungsfrist nicht möglich: Der bestehende COMPLIANCE-Lock ' +
        `läuft bereits ${ctx.oldRetentionYears} Jahre. Bitte Klassifikation beibehalten.`,
    };
  }

  try {
    if (retagDecision === 'METADATA_ONLY') {
      // Gleiche Stufe → reine Metadatenänderung (Bucket/Lock bleiben).
      await withTenantContext(g.ctx, async (tx) => {
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
      });
    } else {
      // Höherstufung → Re-Store: Bytes holen und tier-getrieben mit
      // Object-Lock + Retention neu schreiben. Storage AUSSERHALB der DB-Tx.
      const bytes = await fetchObjectBytes(ctx.bucket, ctx.key);
      const commit = await commitBytesWithTier({
        fileData: bytes,
        tier: ctx.newTier,
        tenantId,
        classification: ctx.newClassification,
        ...(ctx.newTier === 'GOBD' && ctx.newRetentionYears
          ? { retentionYears: ctx.newRetentionYears }
          : {}),
        retentionAnchor: ctx.createdAt,
      });
      await withTenantContext(g.ctx, async (tx) => {
        await tx.documentVersion.update({
          where: { id: ctx!.versionId },
          data: {
            storageBucket: commit.targetBucket,
            storageKey: commit.targetKey,
            immutable: commit.immutable,
            sha256: prismaBytes(commit.sha256),
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
            retentionYears: ctx!.newRetentionYears,
            storageBucket: commit.targetBucket,
          },
        });
      });
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('INFECTED')) {
      return { ok: false, error: 'Datei als infiziert markiert — Retag abgebrochen.' };
    }
    if (msg.startsWith('SCAN_ERROR')) {
      return { ok: false, error: 'Virus-Scan fehlgeschlagen — Retag abgebrochen.' };
    }
    return toActionError(e);
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
  const parsed = ShareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { documentId, share } = parsed.data;

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const d = await tx.document.findFirst({
      where: { id: documentId, tenantId, deletedAt: null },
      select: { clientId: true, sharedWithClientAt: true },
    });
    if (!d) throw new ActionError('Dokument nicht gefunden.');
    if (!d.clientId) {
      throw new ActionError('Nur Mandanten-Dokumente können freigegeben werden.');
    }
    // Freigabe ans Portal ist besonders sensibel → Ventil zwingend.
    await assertClientAccessTx(tx, session, d.clientId);
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
  });

  if (!r.ok) return r;
  revalidatePath('/staff/documents');
  if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
  return { ok: true };
}
