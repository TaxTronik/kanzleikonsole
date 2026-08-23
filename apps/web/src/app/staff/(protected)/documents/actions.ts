'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import {
  fetchObjectBytes,
  commitBytesWithTier,
  deleteObject,
  deleteObjectVersion,
  classificationToTier,
  gobdRetentionYears,
  type CommitDocumentResult,
  type ProtectionTier,
} from '@taxtronik/storage';
import { carrierClassification } from '@/server/storage/document-type';
import { documentRetagDecision } from '@/server/storage/retag-policy';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard, withStaff, ActionError } from '@/server/actions/staff-action';
import { log } from '@/server/logger';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';

export interface DocActionResult {
  ok: boolean;
  error?: string;
}

const GWG_ASSOCIATED_VISIBILITY_ERROR =
  'Dieser Nachweis ist bereits einer GwG-Prüfung zugeordnet und unveränderlich. ' +
  'Ändern Sie die Zuordnung direkt in der GwG-Prüfung; für die endgültige Löschung ' +
  'verwenden Sie den vorgesehenen GwG-Vernichtungsprozess.';

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
 * Object-Store bleibt UNANGETASTET — GoBD liegt unter COMPLIANCE-Lock;
 * GwG-Nachweise werden im GOVERNANCE-Bucket durch den separaten fachlichen
 * Vernichtungsprozess behandelt. Bewusst kein S3-DeleteObject hier:
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
      // Expliziter Tenant-Filter plus Zeilensperre: GwG-Zuordnung und
      // Soft-Delete werden atomar gegeneinander serialisiert.
      const doc = await lockDocumentVisibility(tx, documentId, tenantId);
      if (!doc || doc.deletedAt) {
        throw new ActionError('Dokument nicht gefunden oder bereits gelöscht.');
      }
      // Vertraulich-/RESTRICTED-Ventil für Mandanten-Dokumente.
      if (doc.clientId) await assertClientAccessTx(tx, session, doc.clientId);
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
    versionNo: number;
    bucket: string;
    key: string;
    storageVersionId: string | null;
    immutable: boolean;
    scanStatus: string;
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
            select: {
              id: true,
              versionNo: true,
              storageBucket: true,
              storageKey: true,
              storageVersionId: true,
              immutable: true,
              scanStatus: true,
            },
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
          where: { tenantId, classificationKey: cls, active: true },
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
        versionNo: d.versions[0].versionNo,
        bucket: d.versions[0].storageBucket,
        key: d.versions[0].storageKey,
        storageVersionId: d.versions[0].storageVersionId,
        immutable: d.versions[0].immutable,
        scanStatus: d.versions[0].scanStatus,
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

  if (ctx.scanStatus !== 'CLEAN') {
    return {
      ok: false,
      error: 'Dokument-Upload ist noch nicht abgeschlossen. Bitte zuerst den Upload fortsetzen.',
    };
  }

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

  if (retagDecision === 'BLOCK_GWG_TIER_CHANGE') {
    return {
      ok: false,
      error:
        'GwG-Nachweise können nicht in eine andere Schutzstufe umklassifiziert werden: ' +
        'Ihre eigenständige gesetzliche Vernichtungsfrist muss erhalten bleiben. ' +
        'Legen Sie eine zusätzlich benötigte GoBD-Fassung als separates Dokument ab.',
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

  const lockAndValidateCurrentDocument = async (tx: TxClient, requireLatestSnapshot: boolean) => {
    const lockedRows = await tx.$queryRaw<
      Array<{
        id: string;
        clientId: string | null;
        classification: string;
        documentTypeId: string | null;
      }>
    >`
      SELECT
        id,
        client_id AS "clientId",
        classification::text AS classification,
        document_type_id AS "documentTypeId"
      FROM document
      WHERE id = ${documentId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
      FOR UPDATE
    `;
    const locked = lockedRows[0];
    if (
      !locked ||
      locked.clientId !== ctx!.clientId ||
      locked.classification !== ctx!.oldClassification ||
      locked.documentTypeId !== ctx!.oldTypeId
    ) {
      throw new ActionError(
        'Dokument wurde während der Umklassifizierung geändert. Bitte erneut versuchen.',
      );
    }
    if (locked.clientId) await assertClientAccessTx(tx, g.session, locked.clientId);

    if (ctx!.newTypeId) {
      // Der Typ ist Teil der Storage-/Retention-Entscheidung. Ein bloßes
      // findFirst würde ihn nur lesen; ein paralleles Admin-Update könnte
      // danach Tier oder Frist ändern, bevor das Dokument committed wird.
      // FOR SHARE stabilisiert genau diesen geprüften Typ bis Tx-Ende.
      const targetTypes = await tx.$queryRaw<
        Array<{
          tier: string;
          classificationKey: string;
          retentionYears: number | null;
        }>
      >`
        SELECT
          tier::text AS tier,
          classification_key AS "classificationKey",
          retention_years AS "retentionYears"
        FROM document_type
        WHERE id = ${ctx!.newTypeId}::uuid
          AND tenant_id = ${tenantId}::uuid
          AND active = TRUE
        FOR SHARE
      `;
      const targetType = targetTypes[0];
      if (
        !targetType ||
        targetType.tier !== ctx!.newTier ||
        targetType.retentionYears !== ctx!.newRetentionYears ||
        carrierClassification(targetType.tier as ProtectionTier, targetType.classificationKey) !==
          ctx!.newClassification
      ) {
        throw new ActionError(
          'Datei-Typ wurde während der Umklassifizierung geändert. Bitte erneut versuchen.',
        );
      }
    }

    const latest = await tx.documentVersion.findFirst({
      where: { documentId },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true,
        versionNo: true,
        storageBucket: true,
        storageKey: true,
        storageVersionId: true,
        immutable: true,
        scanStatus: true,
      },
    });
    if (
      requireLatestSnapshot &&
      (!latest ||
        latest.id !== ctx!.versionId ||
        latest.versionNo !== ctx!.versionNo ||
        latest.storageBucket !== ctx!.bucket ||
        latest.storageKey !== ctx!.key ||
        latest.storageVersionId !== ctx!.storageVersionId ||
        latest.immutable !== ctx!.immutable ||
        latest.scanStatus !== ctx!.scanStatus)
    ) {
      throw new ActionError(
        'Neue Dokumentversion während der Umklassifizierung erkannt. Bitte erneut versuchen.',
      );
    }
    return latest;
  };

  let restagedCommit: CommitDocumentResult | null = null;
  try {
    if (retagDecision === 'METADATA_ONLY') {
      // Gleiche Stufe → reine Metadatenänderung (Bucket/Lock bleiben).
      await withTenantContext(g.ctx, async (tx) => {
        await lockAndValidateCurrentDocument(tx, false);
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
      restagedCommit = commit;
      await withTenantContext(g.ctx, async (tx) => {
        const latest = await lockAndValidateCurrentDocument(tx, true);
        if (!latest) {
          throw new ActionError('Dokumentversion nicht mehr vorhanden. Bitte erneut versuchen.');
        }
        if (ctx!.immutable) {
          // Bereits geschützte Versionen (z. B. GWG → GoBD) sind DB-seitig
          // unveränderbar. Die höher geschützte Kopie wird deshalb als neue
          // Version appendiert; die alte geschützte Historie bleibt erhalten.
          await tx.documentVersion.create({
            data: {
              documentId,
              versionNo: latest.versionNo + 1,
              storageBucket: commit.targetBucket,
              storageKey: commit.targetKey,
              storageVersionId: commit.storageVersionId,
              immutable: commit.immutable,
              sha256: prismaBytes(commit.sha256),
              sizeBytes: commit.sizeBytes,
              scanStatus: 'CLEAN',
              scanCompletedAt: new Date(),
              createdById: staffId,
            },
          });
        } else {
          await tx.documentVersion.update({
            where: { id: ctx!.versionId },
            data: {
              storageBucket: commit.targetBucket,
              storageKey: commit.targetKey,
              storageVersionId: commit.storageVersionId,
              immutable: commit.immutable,
              sha256: prismaBytes(commit.sha256),
              sizeBytes: commit.sizeBytes,
            },
          });
        }
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
            appendedVersion: ctx!.immutable,
          },
        });
      });

      // Bei NONE → geschützte Stufe zeigt die bestehende Versionszeile nach
      // erfolgreichem Commit auf die neue Kopie. Das alte ungeschützte Objekt
      // darf danach best-effort physisch entfernt werden.
      if (!ctx.immutable) {
        try {
          if (ctx.storageVersionId) {
            await deleteObjectVersion(ctx.bucket, ctx.key, ctx.storageVersionId);
          } else {
            await deleteObject(ctx.bucket, ctx.key);
          }
        } catch (cleanupError) {
          log.error(
            {
              component: 'document-retag',
              tenantId,
              documentId,
              orphanedBucket: ctx.bucket,
              orphanedKey: ctx.key,
              cleanupErr: (cleanupError as Error).message,
            },
            'document-retag: altes ungeschütztes Objekt konnte nicht entfernt werden',
          );
        }
      }
    }
  } catch (e) {
    if (restagedCommit) {
      await compensateStorageCommit({
        tenantId,
        source: 'staff.document.retag',
        commit: restagedCommit,
        cause: e,
      });
    }
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
