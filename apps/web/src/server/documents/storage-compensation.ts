import type { CommitDocumentResult } from '@taxtronik/storage';
import { prismaOwner } from '@/server/db/prisma-owner';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { log } from '@/server/logger';

export type StorageCompensationDisposition = 'JOURNALED' | 'LOG_ONLY';

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

/**
 * Journalisiert einen bereits erfolgreichen Storage-Commit, wenn der
 * nachgelagerte DB-Commit scheitert oder sein ACK mehrdeutig bleibt.
 *
 * Auch mutable Objekte werden hier bewusst NICHT sofort geloescht: Ein
 * geworfener Commit kann serverseitig bereits erfolgreich gewesen sein. Erst
 * der verzoegerte Cleanup-Worker prueft auf einer frischen Owner-Verbindung,
 * ob irgendeine DocumentVersion die Storage-Identitaet referenziert. Damit
 * wird aus einem unsicheren Sofort-Delete eine wiederholbare Reconciliation.
 * Faellt auch das Journal aus, bleibt ein vollstaendiger strukturierter,
 * secret-freier Betriebsnachweis fuer die manuelle Wiederaufnahme.
 */
export async function compensateStorageCommit(input: {
  tenantId: string;
  source: string;
  commit: CommitDocumentResult;
  cause: unknown;
}): Promise<StorageCompensationDisposition> {
  const { tenantId, source, commit, cause } = input;
  const failure = errorMessage(cause);
  const storageVersionId = commit.storageVersionId ?? '';
  try {
    await prismaOwner.storageOrphan.upsert({
      where: {
        storageBucket_storageKey_storageVersionId: {
          storageBucket: commit.targetBucket,
          storageKey: commit.targetKey,
          storageVersionId,
        },
      },
      create: {
        tenantId,
        source,
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        storageVersionId,
        sha256: prismaBytes(commit.sha256),
        sizeBytes: commit.sizeBytes,
        immutable: commit.immutable,
        retentionUntil: commit.retentionUntil,
        failure,
        cleanupError: null,
      },
      update: {
        source,
        failure,
        cleanupClaimedAt: null,
        cleanupError: null,
        immutable: commit.immutable,
        retentionUntil: commit.retentionUntil,
        cleanedAt: null,
        resolution: null,
      },
    });
    log.error(
      {
        component: 'storage-compensation',
        tenantId,
        source,
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        storageVersionId: commit.storageVersionId,
        immutable: commit.immutable,
        retentionUntil: commit.retentionUntil?.toISOString() ?? null,
      },
      'storage commit queued for delayed reference reconciliation',
    );
    return 'JOURNALED';
  } catch (journalError) {
    log.error(
      {
        component: 'storage-compensation',
        tenantId,
        source,
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        storageVersionId: commit.storageVersionId,
        sha256: commit.sha256.toString('hex'),
        sizeBytes: commit.sizeBytes.toString(),
        immutable: commit.immutable,
        retentionUntil: commit.retentionUntil?.toISOString() ?? null,
        dbFailure: failure,
        journalError: errorMessage(journalError),
      },
      'storage orphan could not be persisted; manual reconciliation required',
    );
    return 'LOG_ONLY';
  }
}
