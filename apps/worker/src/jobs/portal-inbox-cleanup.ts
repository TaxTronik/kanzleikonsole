import { Worker } from 'bullmq';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { recoverPreparedBytesCommit, type CommitDocumentResult } from '@taxtronik/storage';
import { connection } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';

// Fachkatalog: DSGVO-OPERATIONAL-RETENTION-001, DOC-UPLOAD-JOURNAL-001,
// PORTAL-INBOX-SUBMISSION-001 (Entwurf), AUDIT-HASH-CHAIN-001. 24 h / 7 Tage
// sind technische Betriebsdefaults, keine gesetzlichen Fristen.

const DRAFT_TTL_MS = 24 * 60 * 60_000;
const QUARANTINE_MS = 7 * 24 * 60 * 60_000;
const BATCH_SIZE = 200;

const evidence = new EvidenceService(new LocalTimestampAdapter());

interface CleanupCandidate {
  id: string;
  tenantId: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  sha256: Uint8Array;
  sizeBytes: bigint;
  mimeType: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
  decision: 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
  batchStatus: 'CONSUMED' | 'DISCARDED' | 'EXPIRED';
}

function commitFromRow(row: CleanupCandidate): CommitDocumentResult {
  return {
    targetBucket: row.storageBucket,
    targetKey: row.storageKey,
    storageVersionId: row.storageVersionId,
    sha256: Buffer.from(row.sha256),
    sizeBytes: row.sizeBytes,
    immutable: false,
    retentionUntil: null,
    detectedMime: row.mimeType,
  };
}

async function recoverPendingIntent(row: CleanupCandidate): Promise<CommitDocumentResult | null> {
  return recoverPreparedBytesCommit({
    tier: 'NONE',
    tenantId: row.tenantId,
    targetBucket: row.storageBucket,
    targetKey: row.storageKey,
    sha256: Buffer.from(row.sha256),
    sizeBytes: row.sizeBytes,
    immutable: false,
    retentionUntil: null,
    detectedMime: row.mimeType,
  });
}

async function loadTenantCandidates(input: {
  tenantId: string;
  now: Date;
  draftCutoff: Date;
  quarantineCutoff: Date;
}): Promise<{ expiredBatches: number; candidates: CleanupCandidate[] }> {
  return withWorkerTenantContext(input.tenantId, async (tx) => {
    // EXPIRED besitzt absichtlich kein discarded_at: DISCARDED ist eine
    // Kontaktentscheidung, EXPIRED dagegen ein technischer SYSTEM-Uebergang.
    const expired = await tx.portalInboxUploadBatch.updateMany({
      where: {
        tenantId: input.tenantId,
        status: 'OPEN',
        OR: [{ expiresAt: { lte: input.now } }, { createdAt: { lte: input.draftCutoff } }],
      },
      data: { status: 'EXPIRED' },
    });

    // Das dauerhafte StorageOrphan-Journal ist selbst dann der Abschlussbeleg,
    // wenn der gemeinsame Orphan-Worker das Objekt bereits geloescht hat.
    // Darum schliesst NOT EXISTS bewusst auch Zeilen mit cleaned_at ein. Bei
    // einem noch nicht finalisierten Intent (Version NULL) genuegt wegen des
    // global eindeutigen Staging-Keys jede journalisierte Version desselben
    // Tenant-Objekts. So koennen alte Kandidaten den Batch nie aushungern.
    const candidates = await tx.$queryRaw<CleanupCandidate[]>`
      SELECT attachment."id",
             attachment."tenant_id" AS "tenantId",
             attachment."storage_bucket" AS "storageBucket",
             attachment."storage_key" AS "storageKey",
             attachment."storage_version_id" AS "storageVersionId",
             attachment."sha256",
             attachment."size_bytes" AS "sizeBytes",
             attachment."mime_type" AS "mimeType",
             attachment."scan_status"::text AS "scanStatus",
             attachment."decision"::text AS "decision",
             batch."status"::text AS "batchStatus"
        FROM "portal_inbox_attachment" AS attachment
        JOIN "portal_inbox_upload_batch" AS batch
          ON batch."id" = attachment."batch_id"
         AND batch."tenant_id" = attachment."tenant_id"
         AND batch."client_id" = attachment."client_id"
       WHERE attachment."tenant_id" = ${input.tenantId}::uuid
         AND (
           attachment."decision" = 'ACCEPTED'
           OR (
             attachment."decision" IN ('REJECTED', 'BLOCKED')
             AND COALESCE(
               attachment."decided_at",
               attachment."updated_at",
               attachment."created_at"
             ) <= ${input.quarantineCutoff}
           )
           OR (
             attachment."decision" = 'PENDING_REVIEW'
             AND attachment."scan_status" IN ('PENDING', 'CLEAN')
             AND attachment."message_id" IS NULL
             AND attachment."created_at" <= ${input.draftCutoff}
             AND batch."status" IN ('DISCARDED', 'EXPIRED')
           )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM "storage_orphan" AS orphan
            WHERE orphan."tenant_id" = attachment."tenant_id"
              AND orphan."storage_bucket" = attachment."storage_bucket"
              AND orphan."storage_key" = attachment."storage_key"
              AND (
                attachment."storage_version_id" IS NULL
                OR orphan."storage_version_id" = attachment."storage_version_id"
              )
         )
       ORDER BY attachment."created_at" ASC, attachment."id" ASC
       LIMIT ${BATCH_SIZE}
    `;

    return { expiredBatches: expired.count, candidates };
  });
}

async function removeMissingIntent(
  candidate: CleanupCandidate,
  draftCutoff: Date,
): Promise<boolean> {
  return withWorkerTenantContext(candidate.tenantId, async (tx) => {
    const removed = await tx.portalInboxAttachment.deleteMany({
      where: {
        id: candidate.id,
        tenantId: candidate.tenantId,
        storageBucket: candidate.storageBucket,
        storageKey: candidate.storageKey,
        storageVersionId: null,
        scanStatus: 'PENDING',
        decision: 'PENDING_REVIEW',
        messageId: null,
        createdAt: { lte: draftCutoff },
        batch: { status: { in: ['DISCARDED', 'EXPIRED'] } },
      },
    });
    if (removed.count !== 1) return false;

    // Kein Name, MIME-Typ, Hash, Mandantenname oder Scannerdetail im Audit.
    // Delete und Nachweis sind atomar; ein fehlgeschlagener Audit-Write rollt
    // die Intent-Bereinigung zur sicheren Wiederholung zurueck.
    await evidence.record(tx, {
      tenantId: candidate.tenantId,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'portal_inbox.upload_intent.remove_missing',
      resourceType: 'portal_inbox_attachment',
      resourceId: candidate.id,
      after: {
        reasonCode: 'STAGING_OBJECT_NOT_FOUND',
        batchStatus: candidate.batchStatus,
        draftCutoff: draftCutoff.toISOString(),
      },
    });
    return true;
  });
}

async function journalCandidate(
  candidate: CleanupCandidate,
  commit: CommitDocumentResult,
): Promise<void> {
  const storageVersionId = commit.storageVersionId ?? '';
  await withWorkerTenantContext(candidate.tenantId, async (tx) => {
    const journaled = await tx.storageOrphan.upsert({
      where: {
        storageBucket_storageKey_storageVersionId: {
          storageBucket: commit.targetBucket,
          storageKey: commit.targetKey,
          storageVersionId,
        },
      },
      create: {
        tenantId: candidate.tenantId,
        source:
          candidate.decision === 'ACCEPTED'
            ? 'portal-inbox-staging-accepted'
            : candidate.decision === 'REJECTED' || candidate.decision === 'BLOCKED'
              ? 'portal-inbox-quarantine-expired'
              : 'portal-inbox-draft-expired',
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        storageVersionId,
        sha256: new Uint8Array(commit.sha256),
        sizeBytes: commit.sizeBytes,
        immutable: false,
        retentionUntil: null,
        failure: 'PORTAL_INBOX_STAGING_CLEANUP_DUE',
      },
      update: {},
      select: { tenantId: true },
    });
    if (journaled.tenantId !== candidate.tenantId) {
      throw new Error('PORTAL_INBOX_STORAGE_ORPHAN_TENANT_MISMATCH');
    }
  });
}

export async function runPortalInboxCleanup(now = new Date()): Promise<{
  expiredBatches: number;
  queuedObjects: number;
  pendingWithoutObject: number;
  removedMissingIntents: number;
  failed: number;
}> {
  const draftCutoff = new Date(now.getTime() - DRAFT_TTL_MS);
  const quarantineCutoff = new Date(now.getTime() - QUARANTINE_MS);
  const tenantIds = (await prismaOwner.tenant.findMany({ select: { id: true } })).map(
    (tenant) => tenant.id,
  );

  let expiredBatches = 0;
  let candidateCount = 0;
  let queuedObjects = 0;
  let pendingWithoutObject = 0;
  let removedMissingIntents = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    const tenantWork = await loadTenantCandidates({
      tenantId,
      now,
      draftCutoff,
      quarantineCutoff,
    });
    expiredBatches += tenantWork.expiredBatches;
    candidateCount += tenantWork.candidates.length;

    for (const candidate of tenantWork.candidates) {
      try {
        const commit =
          candidate.scanStatus === 'PENDING'
            ? await recoverPendingIntent(candidate)
            : commitFromRow(candidate);
        if (!commit) {
          pendingWithoutObject += 1;
          if (await removeMissingIntent(candidate, draftCutoff)) {
            removedMissingIntents += 1;
          }
          continue;
        }
        await journalCandidate(candidate, commit);
        queuedObjects += 1;
      } catch (error) {
        failed += 1;
        log.error(
          {
            component: 'portal-inbox-cleanup',
            attachmentId: candidate.id,
            tenantId: candidate.tenantId,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          'portal inbox staging cleanup candidate failed',
        );
      }
    }
  }

  log.info(
    {
      component: 'portal-inbox-cleanup',
      tenants: tenantIds.length,
      expiredBatches,
      candidates: candidateCount,
      queuedObjects,
      pendingWithoutObject,
      removedMissingIntents,
      failed,
    },
    'portal inbox cleanup finished',
  );
  return {
    expiredBatches,
    queuedObjects,
    pendingWithoutObject,
    removedMissingIntents,
    failed,
  };
}

export const portalInboxCleanupWorker = new Worker<Record<string, never>>(
  JOB_QUEUES.portalInboxCleanup.name,
  async () => {
    await runPortalInboxCleanup();
  },
  { connection, concurrency: 1 },
);
