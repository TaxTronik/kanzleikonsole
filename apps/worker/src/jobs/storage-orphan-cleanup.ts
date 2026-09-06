import { Worker } from 'bullmq';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { deleteObjectVersion, recoverPreparedBytesCommit } from '@taxtronik/storage';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';

const CLAIM_STALE_MS = 30 * 60_000;
// Ein verlorenes COMMIT-ACK ist zunaechst mehrdeutig. Der Abstand stellt
// sicher, dass die urspruengliche DB-Transaktion beendet ist, bevor wir ihren
// dauerhaft sichtbaren Zustand auf einer frischen Owner-Verbindung bewerten.
const RECONCILIATION_GRACE_MS = 30 * 60_000;
const BATCH_SIZE = 100;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

interface StorageIdentityCandidate {
  id: string;
  tenantId: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string;
}

async function findPersistedReference(
  candidate: StorageIdentityCandidate,
  storageVersionId: string,
) {
  return prismaOwner.documentVersion.findFirst({
    where: {
      storageBucket: candidate.storageBucket,
      storageKey: candidate.storageKey,
      ...(storageVersionId
        ? {
            OR: [{ storageVersionId }, { storageVersionId: null }],
          }
        : {}),
    },
    select: { id: true, document: { select: { tenantId: true } } },
  });
}

async function settlePersistedReference(
  candidate: StorageIdentityCandidate,
  claimedAt: Date,
  persistedReference: { id: string; document: { tenantId: string } },
): Promise<'REFERENCED' | 'INTEGRITY_INCIDENT'> {
  if (persistedReference.document.tenantId !== candidate.tenantId) {
    const updated = await prismaOwner.storageOrphan.updateMany({
      where: { id: candidate.id, cleanedAt: null, cleanupClaimedAt: claimedAt },
      data: {
        cleanupClaimedAt: null,
        cleanedAt: new Date(),
        resolution: 'INTEGRITY_INCIDENT',
        cleanupAttempts: { increment: 1 },
        cleanupError: 'INTEGRITY_CROSS_TENANT_STORAGE_REFERENCE',
      },
    });
    log.error(
      {
        component: 'storage-orphan-cleanup',
        orphanId: candidate.id,
        tenantId: candidate.tenantId,
        referencedTenantId: persistedReference.document.tenantId,
        documentVersionId: persistedReference.id,
        storageBucket: candidate.storageBucket,
        storageKey: candidate.storageKey,
        storageVersionId: candidate.storageVersionId || null,
      },
      'cross-tenant storage reference integrity incident',
    );
    if (updated.count !== 1) {
      throw new Error('STORAGE_ORPHAN_REFERENCE_SETTLEMENT_CONFLICT');
    }
    return 'INTEGRITY_INCIDENT';
  }

  const updated = await prismaOwner.storageOrphan.updateMany({
    where: { id: candidate.id, cleanedAt: null, cleanupClaimedAt: claimedAt },
    data: {
      cleanupClaimedAt: null,
      cleanedAt: new Date(),
      resolution: 'REFERENCED',
      cleanupAttempts: { increment: 1 },
      cleanupError: null,
    },
  });
  if (updated.count !== 1) {
    throw new Error('STORAGE_ORPHAN_REFERENCE_SETTLEMENT_CONFLICT');
  }
  return 'REFERENCED';
}

/**
 * Reconciliert journalisierte Storage-Kandidaten nach einer Sicherheitsfrist.
 * Referenzierte Objekte werden nur als aufgeloest markiert, nie geloescht.
 * Echte Orphans werden versionsgenau entfernt; Object-Lock-Objekte erst nach
 * dem gespeicherten Retention-Ende. Der Claim verhindert parallele Versuche.
 */
export async function runStorageOrphanCleanup(now = new Date()): Promise<{
  claimed: number;
  deleted: number;
  referenced: number;
  incidents: number;
  failed: number;
}> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const reconcileBefore = new Date(now.getTime() - RECONCILIATION_GRACE_MS);
  const candidates = await prismaOwner.storageOrphan.findMany({
    where: {
      cleanedAt: null,
      createdAt: { lte: reconcileBefore },
      AND: [
        { OR: [{ cleanupClaimedAt: null }, { cleanupClaimedAt: { lte: staleBefore } }] },
        { OR: [{ immutable: false }, { retentionUntil: { lte: now } }] },
      ],
    },
    select: {
      id: true,
      tenantId: true,
      storageBucket: true,
      storageKey: true,
      storageVersionId: true,
      sha256: true,
      sizeBytes: true,
      immutable: true,
      retentionUntil: true,
      cleanupAttempts: true,
    },
    // DOC-UPLOAD-JOURNAL-001: Missing/ambiguous versions can remain unresolved.
    // Prioritize fewer attempts so a full failed batch cannot starve later
    // recoverable objects. Age and ID provide a deterministic order per round.
    orderBy: [{ cleanupAttempts: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });

  let claimed = 0;
  let deleted = 0;
  let referenced = 0;
  let incidents = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimedAt = new Date();
    const claim = await prismaOwner.storageOrphan.updateMany({
      where: {
        id: candidate.id,
        cleanedAt: null,
        createdAt: { lte: reconcileBefore },
        AND: [
          { OR: [{ cleanupClaimedAt: null }, { cleanupClaimedAt: { lte: staleBefore } }] },
          { OR: [{ immutable: false }, { retentionUntil: { lte: now } }] },
        ],
      },
      data: { cleanupClaimedAt: claimedAt },
    });
    if (claim.count !== 1) continue;
    claimed += 1;

    try {
      const expectedTenantPrefix = `tenants/${candidate.tenantId}/`;
      if (!candidate.storageKey.startsWith(expectedTenantPrefix)) {
        const updated = await prismaOwner.storageOrphan.updateMany({
          where: { id: candidate.id, cleanedAt: null, cleanupClaimedAt: claimedAt },
          data: {
            cleanupClaimedAt: null,
            cleanedAt: new Date(),
            resolution: 'INTEGRITY_INCIDENT',
            cleanupAttempts: { increment: 1 },
            cleanupError: 'INTEGRITY_TENANT_KEY_PREFIX_MISMATCH',
          },
        });
        if (updated.count === 1) incidents += 1;
        log.error(
          {
            component: 'storage-orphan-cleanup',
            orphanId: candidate.id,
            tenantId: candidate.tenantId,
            storageBucket: candidate.storageBucket,
            storageKey: candidate.storageKey,
          },
          'storage orphan tenant/key integrity incident',
        );
        continue;
      }

      // Bei vorhandener Version-ID ist entweder die exakte Version oder eine
      // noch nicht finalisierte PENDING-Zeile mit identischem Bucket/Key ein
      // belastbarer Referenzhinweis. Ohne Version-ID ist jeder Bucket/Key-
      // Treffer konservativ als referenziert zu behandeln.
      const persistedReference = await findPersistedReference(
        candidate,
        candidate.storageVersionId,
      );
      if (persistedReference) {
        const resolution = await settlePersistedReference(candidate, claimedAt, persistedReference);
        if (resolution === 'REFERENCED') referenced += 1;
        else incidents += 1;
        continue;
      }

      let storageVersionId = candidate.storageVersionId;
      if (!storageVersionId) {
        // DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001: Ein
        // versionierter Key ohne gespeicherte Version-ID darf niemals nur mit
        // einem Delete-Marker verdeckt und danach als physisch geloescht
        // protokolliert werden. Recovery belegt genau eine Hash-/Groessen-
        // identische Version; Mehrdeutigkeit oder Abwesenheit bleiben sichtbar
        // fehlgeschlagen.
        const recovered = await recoverPreparedBytesCommit({
          tier: candidate.immutable ? 'GOBD' : 'NONE',
          tenantId: candidate.tenantId,
          targetBucket: candidate.storageBucket,
          targetKey: candidate.storageKey,
          sha256: Buffer.from(candidate.sha256),
          sizeBytes: candidate.sizeBytes,
          immutable: candidate.immutable,
          retentionUntil: candidate.retentionUntil,
          detectedMime: null,
        });
        if (!recovered?.storageVersionId) {
          throw new Error('STORAGE_ORPHAN_VERSION_NOT_RECOVERED');
        }
        storageVersionId = recovered.storageVersionId;
        const bound = await prismaOwner.storageOrphan.updateMany({
          where: {
            id: candidate.id,
            cleanedAt: null,
            cleanupClaimedAt: claimedAt,
            storageVersionId: '',
          },
          data: { storageVersionId },
        });
        if (bound.count !== 1) {
          throw new Error('STORAGE_ORPHAN_VERSION_BIND_CONFLICT');
        }

        // Zwischen erster Referenzpruefung und Versionsbindung darf kein neuer
        // Dokumentbezug ueberholt werden. Nach der Bindung wird deshalb unter
        // der nun exakten Identitaet erneut konservativ geprueft.
        const lateReference = await findPersistedReference(
          { ...candidate, storageVersionId },
          storageVersionId,
        );
        if (lateReference) {
          const resolution = await settlePersistedReference(
            { ...candidate, storageVersionId },
            claimedAt,
            lateReference,
          );
          if (resolution === 'REFERENCED') referenced += 1;
          else incidents += 1;
          continue;
        }
      }

      await deleteObjectVersion(candidate.storageBucket, candidate.storageKey, storageVersionId);
      const updated = await prismaOwner.storageOrphan.updateMany({
        where: { id: candidate.id, cleanedAt: null, cleanupClaimedAt: claimedAt },
        data: {
          cleanupClaimedAt: null,
          cleanedAt: new Date(),
          resolution: 'DELETED',
          cleanupAttempts: { increment: 1 },
          cleanupError: null,
        },
      });
      if (updated.count === 1) deleted += 1;
    } catch (error) {
      const updated = await prismaOwner.storageOrphan.updateMany({
        where: { id: candidate.id, cleanedAt: null, cleanupClaimedAt: claimedAt },
        data: {
          cleanupClaimedAt: null,
          cleanupAttempts: { increment: 1 },
          cleanupError: errorMessage(error),
        },
      });
      if (updated.count === 1) {
        failed += 1;
        if (candidate.cleanupAttempts >= 4) {
          log.warn(
            {
              component: 'storage-orphan-cleanup',
              orphanId: candidate.id,
              attempts: candidate.cleanupAttempts + 1,
              error: errorMessage(error),
            },
            'storage orphan repeatedly unresolved; operator investigation required',
          );
        }
      }
    }
  }

  log.info(
    {
      component: 'storage-orphan-cleanup',
      candidates: candidates.length,
      claimed,
      deleted,
      referenced,
      incidents,
      failed,
    },
    'storage orphan cleanup finished',
  );
  return { claimed, deleted, referenced, incidents, failed };
}

export const storageOrphanCleanupWorker = new Worker<Record<string, never>>(
  JOB_QUEUES.storageOrphanCleanup.name,
  async () => {
    await runStorageOrphanCleanup();
  },
  { connection, concurrency: 1 },
);
