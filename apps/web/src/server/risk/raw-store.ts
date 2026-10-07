// =============================================================================
// rawResult-Ablage im Object-Store (SeaweedFS) statt in Postgres.
//
// Der vollständige Engine-Output (`rawResult`) ist reines Write-Only-Kaltarchiv
// (Audit/Replay) — zur Laufzeit liest ihn keine Funktion. In Postgres war er der
// größte Einzelposten. Daher: gzip → SeaweedFS, nur Bucket/Key auf RiskAnalysis.
//
// Ablage im GoBD-Bucket mit Object-Lock COMPLIANCE (10 J., § 147 AO) — der
// rawResult ist Teil der revisionssicheren Subsumtions-Dokumentation. Nie
// öffentlich, app-proxied (§ 203 StGB).
//
// K-06 / DOC-UPLOAD-JOURNAL-001: Die Ablage journalisiert ihre Speicherabsicht
// vor dem PUT (storage-intent.ts); die Transaktion, die die Analyse mit dem
// Verweis anlegt, schließt sie ab (persistence.ts). Bricht der Prozess
// dazwischen ab oder scheitert die Transaktion, bleibt die Absicht offen und der
// Cleanup-Worker löst sie nach dem Retention-Ende versionsgenau auf.
// =============================================================================

import { gzipSync, gunzipSync } from 'node:zlib';
import {
  fetchObjectBytes,
  prepareBytesCommitWithTier,
  type CommitDocumentResult,
} from '@taxtronik/storage';
import {
  journalStorageIntents,
  storeStorageIntent,
  type StorageIntent,
} from '@/server/documents/storage-intent';

/** Herkunft der Speicherabsicht im Storage-Orphan-Journal. */
export const RAW_RESULT_INTENT_SOURCE = 'risk.analysis.raw_result';

/** Geschriebenes Rohergebnis samt offener Absicht; die Analyse-Transaktion schließt sie ab. */
export interface StoredRawResult {
  intent: StorageIntent;
  commit: CommitDocumentResult;
}

/**
 * Gzip + journal-first Upload des Engine-rawResult (GoBD, Object-Lock
 * COMPLIANCE). Der Schlüssel folgt dem Schema aller journalisierten Uploads
 * (`tenants/<tenant>/gobd/…`, je Aufruf eindeutig); der Cleanup-Worker prüft
 * diesen Tenant-Präfix.
 */
export async function storeRawResult(
  tenantId: string,
  rawResult: unknown,
): Promise<StoredRawResult> {
  const gz = gzipSync(Buffer.from(JSON.stringify(rawResult ?? null), 'utf8'));
  // App-eigene Bytes (kein Nutzer-Upload): ohne Virenscan wie das Rechnungsarchiv.
  const prepared = await prepareBytesCommitWithTier({
    fileData: gz,
    tier: 'GOBD',
    tenantId,
    skipScan: true,
  });
  const [intent] = await journalStorageIntents({
    tenantId,
    intents: [{ source: RAW_RESULT_INTENT_SOURCE, prepared }],
  });
  const commit = await storeStorageIntent(intent!, gz);
  return { intent: intent!, commit };
}

/**
 * Download + Gunzip + Parse (Forensik/Replay). Ohne gespeicherten Hash: die
 * Analyse führt nur Bucket und Schlüssel (R-05: kein geprüfter Abruf möglich).
 */
export async function fetchRawResult(bucket: string, key: string): Promise<unknown> {
  const bytes = await fetchObjectBytes(bucket, key);
  return JSON.parse(gunzipSync(bytes).toString('utf8'));
}
