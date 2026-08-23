import { Worker } from 'bullmq';
import { deleteObject, deleteObjectVersion } from '@taxtronik/storage';
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
    },
    orderBy: { createdAt: 'asc' },
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
      const persistedReference = await prismaOwner.documentVersion.findFirst({
        where: {
          storageBucket: candidate.storageBucket,
          storageKey: candidate.storageKey,
          ...(candidate.storageVersionId
            ? {
                OR: [{ storageVersionId: candidate.storageVersionId }, { storageVersionId: null }],
              }
            : {}),
        },
        select: { id: true, document: { select: { tenantId: true } } },
      });
      if (persistedReference) {
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
          if (updated.count === 1) incidents += 1;
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
          continue;
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
        if (updated.count === 1) referenced += 1;
        continue;
      }

      if (candidate.storageVersionId) {
        await deleteObjectVersion(
          candidate.storageBucket,
          candidate.storageKey,
          candidate.storageVersionId,
        );
      } else {
        await deleteObject(candidate.storageBucket, candidate.storageKey);
      }
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
      if (updated.count === 1) failed += 1;
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
  'storage-orphan-cleanup',
  async () => {
    await runStorageOrphanCleanup();
  },
  { connection, concurrency: 1 },
);
