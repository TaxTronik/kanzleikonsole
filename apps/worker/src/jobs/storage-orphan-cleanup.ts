import { createWorker } from '../worker-factory';
import type { Worker } from 'bullmq';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { deleteObjectVersion, recoverPreparedBytesCommit } from '@taxtronik/storage';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';
import { isWorkerClosing, startRunBudget, type RunBudget } from '../run-budget';

const CLAIM_STALE_MS = 30 * 60_000;
// Ein verlorenes COMMIT-ACK ist zunaechst mehrdeutig. Der Abstand stellt
// sicher, dass die urspruengliche DB-Transaktion beendet ist, bevor wir ihren
// dauerhaft sichtbaren Zustand auf einer frischen Owner-Verbindung bewerten.
const RECONCILIATION_GRACE_MS = 30 * 60_000;
const BATCH_SIZE = 100;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

/** Fällige, unaufgelöste Kandidaten zum Zeitpunkt `now` (Auswahl, Claim und Rückstand). */
function dueWhere(now: Date) {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const reconcileBefore = new Date(now.getTime() - RECONCILIATION_GRACE_MS);
  return {
    cleanedAt: null,
    createdAt: { lte: reconcileBefore },
    AND: [
      { OR: [{ cleanupClaimedAt: null }, { cleanupClaimedAt: { lte: staleBefore } }] },
      { OR: [{ immutable: false }, { retentionUntil: { lte: now } }] },
    ],
  };
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

async function findDueCandidates(now: Date, retryLater: readonly string[]) {
  return prismaOwner.storageOrphan.findMany({
    where: {
      ...dueWhere(now),
      // P-17: in diesem Lauf bereits versuchte, weiter offene Kandidaten nicht erneut ziehen.
      ...(retryLater.length > 0 ? { id: { notIn: [...retryLater] } } : {}),
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
}

type Candidate = Awaited<ReturnType<typeof findDueCandidates>>[number];
type Settlement = 'deleted' | 'referenced' | 'incident' | 'unsettled';
type Outcome = Settlement | 'failed' | 'claim-lost';

/**
 * Bewertet einen geclaimten Kandidaten: Integritätsprüfung, Referenzprüfung,
 * ggf. Versions-Recovery und versionsgenaues Löschen. Wirft bei Fehlern; der
 * Aufrufer gibt den Claim dann frei und persistiert den Fehler.
 */
async function settleClaimedCandidate(candidate: Candidate, claimedAt: Date): Promise<Settlement> {
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
    return updated.count === 1 ? 'incident' : 'unsettled';
  }

  // Bei vorhandener Version-ID ist entweder die exakte Version oder eine
  // noch nicht finalisierte PENDING-Zeile mit identischem Bucket/Key ein
  // belastbarer Referenzhinweis. Ohne Version-ID ist jeder Bucket/Key-
  // Treffer konservativ als referenziert zu behandeln.
  const persistedReference = await findPersistedReference(candidate, candidate.storageVersionId);
  if (persistedReference) {
    const resolution = await settlePersistedReference(candidate, claimedAt, persistedReference);
    return resolution === 'REFERENCED' ? 'referenced' : 'incident';
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
      return resolution === 'REFERENCED' ? 'referenced' : 'incident';
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
  return updated.count === 1 ? 'deleted' : 'unsettled';
}

/** Claimt einen Kandidaten atomar und bewertet ihn; Fehler geben den Claim frei. */
async function processCandidate(candidate: Candidate, now: Date): Promise<Outcome> {
  const claimedAt = new Date();
  const claim = await prismaOwner.storageOrphan.updateMany({
    where: { id: candidate.id, ...dueWhere(now) },
    data: { cleanupClaimedAt: claimedAt },
  });
  if (claim.count !== 1) return 'claim-lost';

  try {
    return await settleClaimedCandidate(candidate, claimedAt);
  } catch (error) {
    const updated = await prismaOwner.storageOrphan.updateMany({
      where: { id: candidate.id, cleanedAt: null, cleanupClaimedAt: claimedAt },
      data: {
        cleanupClaimedAt: null,
        cleanupAttempts: { increment: 1 },
        cleanupError: errorMessage(error),
      },
    });
    if (updated.count !== 1) return 'unsettled';
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
    return 'failed';
  }
}

export interface StorageOrphanCleanupResult {
  claimed: number;
  deleted: number;
  referenced: number;
  incidents: number;
  failed: number;
  /** P-17: nach dem Lauf weiterhin fällige, unaufgelöste Kandidaten. */
  backlog: number;
  /** P-17: der Lauf endete am Zeitbudget oder wegen Herunterfahrens. */
  budgetExhausted: boolean;
}

type Totals = Pick<
  StorageOrphanCleanupResult,
  'claimed' | 'deleted' | 'referenced' | 'incidents' | 'failed'
>;

const OUTCOME_TOTAL: Partial<Record<Outcome, keyof Totals>> = {
  deleted: 'deleted',
  referenced: 'referenced',
  incident: 'incidents',
  failed: 'failed',
};

/** Arbeitet einen Batch ab; false = Budget erschöpft, bevor alle Kandidaten dran waren. */
async function processBatch(
  candidates: readonly Candidate[],
  now: Date,
  budget: RunBudget,
  totals: Totals,
  retryLater: string[],
): Promise<boolean> {
  for (const candidate of candidates) {
    if (budget.exhausted()) return false;
    const outcome = await processCandidate(candidate, now);
    if (outcome !== 'claim-lost') totals.claimed += 1;
    const total = OUTCOME_TOTAL[outcome];
    if (total) totals[total] += 1;
    if (outcome === 'failed' || outcome === 'claim-lost' || outcome === 'unsettled') {
      retryLater.push(candidate.id);
    }
  }
  return true;
}

/**
 * Reconciliert journalisierte Storage-Kandidaten nach einer Sicherheitsfrist.
 * Referenzierte Objekte werden nur als aufgeloest markiert, nie geloescht.
 * Echte Orphans werden versionsgenau entfernt; Object-Lock-Objekte erst nach
 * dem gespeicherten Retention-Ende. Der Claim verhindert parallele Versuche.
 *
 * P-17: Ein Lauf zieht Batch um Batch, bis kein fälliger Kandidat mehr übrig
 * ist oder das Zeitbudget endet. Kandidaten, die in diesem Lauf scheiterten,
 * kommen erst im nächsten Lauf wieder an die Reihe. Der verbleibende Rückstand
 * (fällige, unaufgelöste Kandidaten inkl. gescheiterter) steht im Ergebnis.
 */
export async function runStorageOrphanCleanup(
  now = new Date(),
  budget: RunBudget = startRunBudget(),
): Promise<StorageOrphanCleanupResult> {
  const totals: Totals = { claimed: 0, deleted: 0, referenced: 0, incidents: 0, failed: 0 };
  const retryLater: string[] = [];
  let candidates = 0;
  let budgetExhausted = false;
  for (;;) {
    if (budget.exhausted()) {
      budgetExhausted = true;
      break;
    }
    const batch = await findDueCandidates(now, retryLater);
    candidates += batch.length;
    if (!(await processBatch(batch, now, budget, totals, retryLater))) {
      budgetExhausted = true;
      break;
    }
    // Ein nicht voller Batch enthielt alle fälligen Kandidaten dieses Laufs.
    if (batch.length < BATCH_SIZE) break;
  }
  const backlog = await prismaOwner.storageOrphan.count({ where: dueWhere(now) });

  const result: StorageOrphanCleanupResult = { ...totals, backlog, budgetExhausted };
  log.info(
    { component: 'storage-orphan-cleanup', candidates, ...result },
    'storage orphan cleanup finished',
  );
  return result;
}

// Typ explizit: der Processor liest `closing` des eigenen Workers (P-17).
export const storageOrphanCleanupWorker: Worker<Record<string, never>> = createWorker<
  Record<string, never>
>(
  JOB_QUEUES.storageOrphanCleanup.name,
  async () =>
    runStorageOrphanCleanup(
      new Date(),
      startRunBudget({ stop: () => isWorkerClosing(storageOrphanCleanupWorker) }),
    ),
  { connection, concurrency: 1 },
);
