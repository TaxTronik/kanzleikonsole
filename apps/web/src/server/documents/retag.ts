// =============================================================================
// Umklassifizierung (Retag) von Dokumenten (Review-Finding K-03).
//
// Fachkatalog: DOC-VERSION-IMMUTABILITY-001, DOC-RETENTION-CLASS-001,
// DOC-OBJECT-LOCK-001, DOC-UPLOAD-JOURNAL-001
//
// Einzel-Action (retagDocumentAction) und Bulk-Action (retagDocumentsAction)
// laufen über dieselben Schritte dieses Moduls; die Actions parsen nur noch,
// rufen den Service und revalidieren.
//
// Schutzstufen-Logik (iter55: Stufe statt roher Klassifikation). Die Stufe
// steuert Bucket + Object-Lock + Aufbewahrung:
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
//
// Ablauf je Dokument:
//   1. Stand laden (Dokument, Typ, neueste Version) und Ziel auflösen
//   2. retagStep entscheidet vor jedem Write: unverändert, Metadaten,
//      Re-Store oder Ablehnung
//   3a. Metadaten: eine Transaktion (Zeilensperre → Typ FOR SHARE → Audit)
//   3b. Re-Store: journal-first (K-06) zwischen Vor- und Nachprüfung, danach
//      best-effort Entfernen des alten ungeschützten Objekts
// =============================================================================

import { withTenantContext, type TxClient } from '@taxtronik/db';
import {
  fetchObjectBytes,
  deleteObject,
  deleteObjectVersion,
  classificationToTier,
  gobdRetentionYears,
  UploadRejectedError,
  type ProtectionTier,
} from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { carrierClassification } from '@/server/storage/document-type';
import { documentRetagDecision } from '@/server/storage/retag-policy';
import { toActionError, type ActionErrorResult } from '@/server/auth/rbac';
import { ActionError, type StaffCtx } from '@/server/actions/staff-action';
import { log } from '@/server/logger';
import { runJournaledUpload, uploadFailureCause } from '@/server/documents/journaled-upload';
import {
  clientAccessCheck,
  lockDocumentRows,
  runDocumentBulk,
  type AssertClientAccess,
  type DocumentBulkRejection,
} from '@/server/documents/document-bulk';

type StaffActor = Pick<StaffCtx, 'tenantId' | 'staffId'>;

/** Kern-Klassifikationen, die eine Umklassifizierung direkt annimmt. */
export const RETAG_CLASSIFICATIONS = [
  'GOBD_INVOICE',
  'GOBD_CONTRACT',
  'GOBD_TAX',
  'GWG_EVIDENCE',
  'PERSONNEL',
  'STAFF_PRIVATE',
  'GENERAL',
] as const;

export type RetagClassification = (typeof RETAG_CLASSIFICATIONS)[number];

/** Gewünschtes Ziel: Datei-Typ oder (Altbestand) Kern-Klassifikation. */
export type RetagInput = {
  documentTypeId?: string;
  classification?: RetagClassification;
};

/** Ziel der Umklassifizierung: Stufe, Carrier-Klassifikation, Typ-ID, Frist. */
export interface RetagTarget {
  newTier: ProtectionTier;
  newTypeId: string | null;
  newClassification: string;
  newRetentionYears: number | null;
}

/** Stand des Dokuments und seiner neuesten Version beim Laden. */
export interface RetagSnapshot {
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
}

export type RetagPlan = RetagSnapshot & RetagTarget;

export async function resolveRetagTarget(
  tx: TxClient,
  tenantId: string,
  input: RetagInput,
): Promise<RetagTarget> {
  if (input.documentTypeId) {
    const t = await tx.documentType.findFirst({
      where: { id: input.documentTypeId, tenantId, active: true },
      select: { id: true, tier: true, classificationKey: true, retentionYears: true },
    });
    if (!t) throw new ActionError('Datei-Typ nicht gefunden.');
    return {
      newTier: t.tier as ProtectionTier,
      newTypeId: t.id,
      newClassification: carrierClassification(t.tier as ProtectionTier, t.classificationKey),
      newRetentionYears: t.retentionYears,
    };
  }
  const cls = input.classification!;
  const builtin = await tx.documentType.findFirst({
    where: { tenantId, classificationKey: cls, active: true },
    select: { id: true },
  });
  const newTier = classificationToTier(cls);
  return {
    newTier,
    newTypeId: builtin?.id ?? null,
    newClassification: cls,
    newRetentionYears: newTier === 'GOBD' ? gobdRetentionYears(cls) : newTier === 'GWG' ? 5 : null,
  };
}

/** Dokument + aktuellen Typ + neueste Version laden; null, wenn nicht vorhanden. */
export async function loadRetagSnapshot(
  tx: TxClient,
  tenantId: string,
  documentId: string,
  assertAccess: AssertClientAccess,
): Promise<RetagSnapshot | null> {
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
  // Vertraulich-/RESTRICTED-Ventil (ForbiddenError wird via toActionError
  // gemappt).
  if (d.clientId) await assertAccess(d.clientId);
  const oldTier =
    (d.documentType?.tier as ProtectionTier | undefined) ?? classificationToTier(d.classification);
  return {
    oldTier,
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
      (oldTier === 'GOBD' ? gobdRetentionYears(d.classification) : oldTier === 'GWG' ? 5 : null),
  };
}

export type RetagStep =
  | { kind: 'NOOP' }
  | { kind: 'METADATA_ONLY' }
  | { kind: 'RESTORE' }
  | { kind: 'REJECT'; error: string };

/** Entscheidung vor jedem Write: unverändert, Metadaten, Re-Store oder Ablehnung. */
export function retagStep(plan: RetagPlan): RetagStep {
  if (plan.scanStatus !== 'CLEAN') {
    return {
      kind: 'REJECT',
      error: 'Dokument-Upload ist noch nicht abgeschlossen. Bitte zuerst den Upload fortsetzen.',
    };
  }
  if (plan.newTypeId && plan.newTypeId === plan.oldTypeId) return { kind: 'NOOP' };

  switch (
    documentRetagDecision({
      oldTier: plan.oldTier,
      newTier: plan.newTier,
      oldRetentionYears: plan.oldRetentionYears,
      newRetentionYears: plan.newRetentionYears,
    })
  ) {
    case 'BLOCK_TIER_DOWNGRADE':
      return {
        kind: 'REJECT',
        error:
          'Herabstufung nicht möglich: Die gesetzliche Aufbewahrung (Object-Lock) ' +
          'lässt sich nicht entfernen. GoBD/GwG kann nicht auf eine schwächere ' +
          'Stufe zurückgesetzt werden.',
      };
    case 'BLOCK_GWG_TIER_CHANGE':
      return {
        kind: 'REJECT',
        error:
          'GwG-Nachweise können nicht in eine andere Schutzstufe umklassifiziert werden: ' +
          'Ihre eigenständige gesetzliche Vernichtungsfrist muss erhalten bleiben. ' +
          'Legen Sie eine zusätzlich benötigte GoBD-Fassung als separates Dokument ab.',
      };
    case 'BLOCK_RETENTION_SHORTENING':
      return {
        kind: 'REJECT',
        error:
          'Kürzere Aufbewahrungsfrist nicht möglich: Der bestehende COMPLIANCE-Lock ' +
          `läuft bereits ${plan.oldRetentionYears} Jahre. Bitte Klassifikation beibehalten.`,
      };
    case 'METADATA_ONLY':
      return { kind: 'METADATA_ONLY' };
    default:
      return { kind: 'RESTORE' };
  }
}

/**
 * Sperrt das Dokument und prüft, dass es seit dem Laden unverändert ist
 * (Mandant, Klassifikation, Typ; für den Re-Store auch die neueste Version).
 */
async function lockRetagDocument(
  tx: TxClient,
  tenantId: string,
  documentId: string,
  plan: RetagPlan,
  assertAccess: AssertClientAccess,
  requireLatestSnapshot: boolean,
) {
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
    locked.clientId !== plan.clientId ||
    locked.classification !== plan.oldClassification ||
    locked.documentTypeId !== plan.oldTypeId
  ) {
    throw new ActionError(
      'Dokument wurde während der Umklassifizierung geändert. Bitte erneut versuchen.',
    );
  }
  if (locked.clientId) await assertAccess(locked.clientId);

  if (plan.newTypeId) {
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
      WHERE id = ${plan.newTypeId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND active = TRUE
      FOR SHARE
    `;
    const targetType = targetTypes[0];
    if (
      !targetType ||
      targetType.tier !== plan.newTier ||
      targetType.retentionYears !== plan.newRetentionYears ||
      carrierClassification(targetType.tier as ProtectionTier, targetType.classificationKey) !==
        plan.newClassification
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
      latest.id !== plan.versionId ||
      latest.versionNo !== plan.versionNo ||
      latest.storageBucket !== plan.bucket ||
      latest.storageKey !== plan.key ||
      latest.storageVersionId !== plan.storageVersionId ||
      latest.immutable !== plan.immutable ||
      latest.scanStatus !== plan.scanStatus)
  ) {
    throw new ActionError(
      'Neue Dokumentversion während der Umklassifizierung erkannt. Bitte erneut versuchen.',
    );
  }
  return latest;
}

/** Gleiche Stufe → reine Metadatenänderung (Bucket/Lock bleiben). */
export async function applyMetadataRetagTx(
  tx: TxClient,
  { tenantId, staffId }: StaffActor,
  documentId: string,
  plan: RetagPlan,
  assertAccess: AssertClientAccess,
): Promise<{ clientId: string | null }> {
  await lockRetagDocument(tx, tenantId, documentId, plan, assertAccess, false);
  await tx.document.update({
    where: { id: documentId },
    data: {
      classification: plan.newClassification as never,
      documentTypeId: plan.newTypeId,
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'document.retag',
    resourceType: 'document',
    resourceId: documentId,
    before: { classification: plan.oldClassification, tier: plan.oldTier },
    after: { classification: plan.newClassification, tier: plan.newTier, reStored: false },
  });
  return { clientId: plan.clientId };
}

/**
 * Höherstufung → Re-Store: Bytes holen und tier-getrieben mit Object-Lock +
 * Retention neu schreiben. Storage AUSSERHALB der DB-Tx.
 * K-06 / DOC-UPLOAD-JOURNAL-001: dieselbe Dokumentprüfung vor und nach dem
 * Write; die Speicherabsicht steht vor dem PUT im Journal und wird mit dem
 * Versionsbezug atomar abgeschlossen.
 */
export async function restoreRetagDocument(
  g: StaffCtx,
  documentId: string,
  plan: RetagPlan,
): Promise<void> {
  const { tenantId, staffId } = g;
  const checkCurrentVersion = async (tx: TxClient) => {
    const latest = await lockRetagDocument(
      tx,
      tenantId,
      documentId,
      plan,
      clientAccessCheck(tx, g.session),
      true,
    );
    if (!latest) {
      throw new ActionError('Dokumentversion nicht mehr vorhanden. Bitte erneut versuchen.');
    }
    return latest;
  };
  await runJournaledUpload({
    context: g.ctx,
    source: 'staff.document.retag',
    check: checkCurrentVersion,
    readBytes: () => fetchObjectBytes(plan.bucket, plan.key, plan.storageVersionId),
    storage: () => ({
      tier: plan.newTier,
      classification: plan.newClassification,
      ...(plan.newTier === 'GOBD' && plan.newRetentionYears
        ? { retentionYears: plan.newRetentionYears }
        : {}),
      retentionAnchor: plan.createdAt,
    }),
    commitTx: async (tx, { commit, checked: latest }) => {
      if (plan.immutable) {
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
          where: { id: plan.versionId },
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
          classification: plan.newClassification as never,
          documentTypeId: plan.newTypeId,
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
        before: { classification: plan.oldClassification, tier: plan.oldTier },
        after: {
          classification: plan.newClassification,
          tier: plan.newTier,
          reStored: true,
          retentionYears: plan.newRetentionYears,
          storageBucket: commit.targetBucket,
          appendedVersion: plan.immutable,
        },
      });
    },
  });

  // Bei NONE → geschützte Stufe zeigt die bestehende Versionszeile nach
  // erfolgreichem Commit auf die neue Kopie. Das alte ungeschützte Objekt
  // darf danach best-effort physisch entfernt werden.
  if (!plan.immutable) {
    try {
      if (plan.storageVersionId) {
        await deleteObjectVersion(plan.bucket, plan.key, plan.storageVersionId);
      } else {
        await deleteObject(plan.bucket, plan.key);
      }
    } catch (cleanupError) {
      log.error(
        {
          component: 'document-retag',
          tenantId,
          documentId,
          orphanedBucket: plan.bucket,
          orphanedKey: plan.key,
          cleanupErr: (cleanupError as Error).message,
        },
        'document-retag: altes ungeschütztes Objekt konnte nicht entfernt werden',
      );
    }
  }
}

/**
 * Fehlermeldung einer gescheiterten Umklassifizierung. Nach dem Object-Write
 * bleibt die Speicherabsicht offen; der Cleanup-Worker räumt das Objekt nach
 * der Sicherheitsfrist versionsgenau auf.
 */
export function retagFailureMessage(error: unknown): string {
  // Nach dem Object-Write bleibt die Speicherabsicht offen; der Cleanup-Worker
  // räumt das Objekt nach der Sicherheitsfrist versionsgenau auf. F-03:
  // Scan-Ergebnisse nach Fehlerklasse statt nach Meldungstext.
  const cause = uploadFailureCause(error);
  if (cause instanceof UploadRejectedError && cause.reason === 'INFECTED') {
    return 'Datei als infiziert markiert — Retag abgebrochen.';
  }
  if (cause instanceof UploadRejectedError && cause.reason === 'SCAN_ERROR') {
    return 'Virus-Scan fehlgeschlagen — Retag abgebrochen.';
  }
  return toActionError(cause).error;
}

/**
 * Ergebnis der Einzel-Umklassifizierung. `changed: false`: das Dokument hat
 * den Ziel-Typ bereits (nichts geschrieben, nichts zu revalidieren).
 */
export type RetagDocumentResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; clientId: string | null }
  | ActionErrorResult;

/**
 * Einzel-Umklassifizierung. Mehrstufig (DB-Tx ↔ Storage ↔ DB-Tx) mit
 * Sonderfehlern (INFECTED/SCAN): Laden und Ziel in einer Transaktion,
 * danach Metadaten-Transaktion oder journal-first Re-Store.
 */
export async function retagDocument(
  g: StaffCtx,
  documentId: string,
  input: RetagInput,
): Promise<RetagDocumentResult> {
  const { tenantId } = g;

  // 1. Dokument + aktuellen Typ + neueste Version laden, danach das Ziel
  //    auflösen (Stufe + Carrier-Klassifikation + Typ-ID).
  let loaded: RetagPlan | null;
  try {
    loaded = await withTenantContext(g.ctx, async (tx) => {
      const snapshot = await loadRetagSnapshot(
        tx,
        tenantId,
        documentId,
        clientAccessCheck(tx, g.session),
      );
      if (!snapshot) return null;
      return { ...snapshot, ...(await resolveRetagTarget(tx, tenantId, input)) };
    });
  } catch (e) {
    return toActionError(e);
  }
  if (!loaded) return { ok: false, error: 'Dokument oder Version nicht gefunden.' };
  const plan = loaded;

  const step = retagStep(plan);
  if (step.kind === 'REJECT') return { ok: false, error: step.error };
  if (step.kind === 'NOOP') return { ok: true, changed: false };

  try {
    if (step.kind === 'METADATA_ONLY') {
      await withTenantContext(g.ctx, (tx) =>
        applyMetadataRetagTx(tx, g, documentId, plan, clientAccessCheck(tx, g.session)),
      );
    } else {
      await restoreRetagDocument(g, documentId, plan);
    }
  } catch (error) {
    return { ok: false, error: retagFailureMessage(error) };
  }
  return { ok: true, changed: true, clientId: plan.clientId };
}

/**
 * Re-Stores laufen je Dokument mit Objekt-Kopie und Virenscan. Nach diesem
 * Budget beginnt die Action keinen weiteren; die übrigen meldet sie als
 * `pending`, der Client reicht sie mit dem nächsten Aufruf nach. So bleibt
 * jede Anfrage deutlich unter dem Proxy-Timeout (nginx: 60 s).
 */
export const RETAG_RESTORE_BUDGET_MS = 20_000;

/**
 * Ergebnis der Bulk-Umklassifizierung. `ok: false`: Das Ziel war nicht
 * auflösbar, kein Dokument wurde verarbeitet. Sonst je Dokument erledigt,
 * abgelehnt oder (Zeitbudget) offen, dazu die Mandanten geänderter Dokumente.
 */
export type RetagDocumentsResult =
  | ActionErrorResult
  | {
      ok: true;
      done: number;
      rejected: DocumentBulkRejection[];
      pending: string[];
      changedClients: Array<string | null>;
    };

/**
 * P-18: Umklassifizierung einer Auswahl. Reine Metadatenänderungen laufen in
 * einer Transaktion; Höherstufungen brauchen je Dokument den journal-first
 * Re-Store (K-06) zwischen Vor- und Nachprüfung und laufen nacheinander.
 * `startedAt` ist der Beginn der Action: das Re-Store-Budget gilt je Aufruf.
 */
export async function retagDocuments(
  g: StaffCtx,
  documentIds: readonly string[],
  input: RetagInput,
  { startedAt }: { startedAt: number },
): Promise<RetagDocumentsResult> {
  const { tenantId } = g;

  let target: RetagTarget;
  try {
    target = await withTenantContext(g.ctx, (tx) => resolveRetagTarget(tx, tenantId, input));
  } catch (e) {
    return { ok: false, error: toActionError(e).error };
  }

  // 1. Stand aller Dokumente laden (Zugriff je Dokument), dann entscheiden.
  const loaded = await runDocumentBulk(
    g,
    documentIds.map((id) => ({ id })),
    async (tx, { id }, assertAccess) => {
      const snapshot = await loadRetagSnapshot(tx, tenantId, id, assertAccess);
      if (!snapshot) throw new ActionError('Dokument oder Version nicht gefunden.');
      return snapshot;
    },
    { component: 'document-bulk-retag' },
  );
  const rejected = [...loaded.rejected];
  let done = 0;
  const metadata: Array<{ id: string; plan: RetagPlan }> = [];
  const restores: Array<{ id: string; plan: RetagPlan }> = [];
  for (const { id, value } of loaded.done) {
    const plan: RetagPlan = { ...value, ...target };
    const step = retagStep(plan);
    if (step.kind === 'REJECT') rejected.push({ id, error: step.error });
    else if (step.kind === 'NOOP') done += 1;
    else (step.kind === 'METADATA_ONLY' ? metadata : restores).push({ id, plan });
  }

  // 2. Gleiche Stufe: alle Metadatenänderungen in einer Transaktion.
  const changedClients: Array<string | null> = [];
  if (metadata.length > 0) {
    const applied = await runDocumentBulk(
      g,
      metadata,
      (tx, { id, plan }, assertAccess) => applyMetadataRetagTx(tx, g, id, plan, assertAccess),
      {
        component: 'document-bulk-retag',
        lockBlock: (tx, block) => lockDocumentRows(tx, g.tenantId, block),
      },
    );
    done += applied.done.length;
    rejected.push(...applied.rejected);
    changedClients.push(...applied.done.map(({ value }) => value.clientId));
  }

  // 3. Höherstufung: je Dokument journal-first, nacheinander, im Zeitbudget.
  const pending: string[] = [];
  let attempted = 0;
  for (const { id, plan } of restores) {
    if (attempted > 0 && Date.now() - startedAt > RETAG_RESTORE_BUDGET_MS) {
      pending.push(id);
      continue;
    }
    attempted += 1;
    try {
      await restoreRetagDocument(g, id, plan);
      done += 1;
      changedClients.push(plan.clientId);
    } catch (error) {
      rejected.push({ id, error: retagFailureMessage(error) });
    }
  }

  return { ok: true, done, rejected, pending, changedClients };
}
