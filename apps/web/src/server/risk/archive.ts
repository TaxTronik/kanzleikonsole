// =============================================================================
// Revisionssichere Archivierung einer Subsumtion (GoBD / § 147 AO).
//
// Erzeugt einen self-contained Snapshot (Sachverhalt + ALLE Markierungen mit
// Governance/Normketten + Metadaten + Hash) als gzip-JSON im GoBD-Bucket mit
// Object-Lock COMPLIANCE (10 J., unveränderlich). Das ist die Langzeit-
// Aufbewahrung: Sachverhalt + Normketten liegen damit im Cold Storage, der
// Snapshot ist selbst hash-verankert (audit_log). Die Live-Daten bleiben in
// Postgres abfragbar, aber die Analyse wird schreibgeschützt (Mutationen
// werden über die Guards abgelehnt).
//
// K-06 / DOC-UPLOAD-JOURNAL-001: Die Speicherabsicht steht vor dem PUT im
// Journal; die Transaktion, die den Archivverweis bindet, schließt sie ab.
// Scheitert sie (z. B. Stand zwischenzeitlich geändert) oder bricht der Prozess
// zwischen PUT und Commit ab, bleibt die Absicht offen und der Cleanup-Worker
// löscht das Objekt nach dem Retention-Ende versionsgenau.
// =============================================================================

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import {
  commitRiskArchiveTx,
  readRiskArchiveStateTx,
  riskArchiveStateHash,
  RiskAnalysisArchivedError,
} from '@taxtronik/db/risk-analysis';
import { prepareBytesCommitWithTier, type CommitDocumentResult } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import {
  journalStorageIntents,
  releaseStorageIntent,
  settleStorageIntentTx,
  storeStorageIntent,
  type StorageIntent,
} from '@/server/documents/storage-intent';

export { RiskAnalysisArchivedError as AlreadyArchivedError };

/** Herkunft der Speicherabsicht im Storage-Orphan-Journal. */
export const ARCHIVE_INTENT_SOURCE = 'risk.analysis.archive';

export async function archiveAnalysis(
  ctx: TenantContext,
  analysisId: string,
): Promise<{ bucket: string; key: string; snapshotHash: string }> {
  const state = await withTenantContext(ctx, (tx) =>
    readRiskArchiveStateTx(tx, ctx.tenantId, analysisId),
  );
  const expectedStateHash = riskArchiveStateHash(state);
  const archivedAt = new Date();

  // Self-contained Snapshot — alles, was die Subsumtion ausmacht.
  const payload = {
    schemaVersion: 2,
    archivedAt: archivedAt.toISOString(),
    ...state,
  };
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const snapshotHash = createHash('sha256').update(json).digest('hex');
  const gz = gzipSync(json);

  // Jeder Versuch erhält einen eigenen Schlüssel: Object Lock schützt Versionen,
  // nicht den aktuellen Stand eines Schlüssels — ein unterlegener paralleler
  // Versuch ersetzt nie die referenzierten Bytes des Gewinners. App-eigene Bytes:
  // ohne Virenscan. Object-Lock COMPLIANCE → unveränderlich bis Retention-Ende.
  const prepared = await prepareBytesCommitWithTier({
    fileData: gz,
    tier: 'GOBD',
    tenantId: ctx.tenantId,
    skipScan: true,
  });
  const [journaled] = await journalStorageIntents({
    tenantId: ctx.tenantId,
    intents: [{ source: ARCHIVE_INTENT_SOURCE, prepared }],
  });
  const intent = journaled!;
  const stored = await storeStorageIntent(intent, gz);
  const bucket = stored.targetBucket;
  const key = stored.targetKey;

  try {
    await withTenantContext(ctx, (tx) =>
      bindArchiveTx(tx, ctx, {
        analysisId,
        expectedStateHash,
        archivedAt,
        snapshotHash,
        markingCount: state.markings.length,
        textHash: state.analysis.textHash,
        intent,
        stored,
      }),
    );
  } catch (error) {
    // Kein Archivverweis entstanden: Die Absicht bleibt mit gebundener
    // Objektversion offen; der Cleanup-Worker räumt nach dem Retention-Ende auf.
    await releaseStorageIntent({ intent, commit: stored, cause: error });
    throw error;
  }

  return { bucket, key, snapshotHash };
}

/**
 * Archivverweis, Abschluss der Speicherabsicht und Audit in einer Transaktion
 * (K-06: Verweis und Abschluss atomar).
 */
async function bindArchiveTx(
  tx: TxClient,
  ctx: TenantContext,
  input: {
    analysisId: string;
    expectedStateHash: string;
    archivedAt: Date;
    snapshotHash: string;
    markingCount: number;
    textHash: string;
    intent: StorageIntent;
    stored: CommitDocumentResult;
  },
): Promise<void> {
  const { analysisId, stored } = input;
  const bucket = stored.targetBucket;
  const key = stored.targetKey;
  await commitRiskArchiveTx(tx, {
    tenantId: ctx.tenantId,
    analysisId,
    expectedStateHash: input.expectedStateHash,
    archivedAt: input.archivedAt,
    bucket,
    key,
  });
  await settleStorageIntentTx(tx, input.intent, stored);
  await evidenceService.record(tx, {
    tenantId: ctx.tenantId,
    actorType: 'STAFF',
    actorId: ctx.actorId,
    action: 'risk.analysis.archived',
    resourceType: 'risk_analysis',
    resourceId: analysisId,
    after: {
      archiveBucket: bucket,
      archiveKey: key,
      snapshotHash: input.snapshotHash,
      markingCount: input.markingCount,
      textHash: input.textHash,
    },
  });
}
