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
// =============================================================================

import { gzipSync, gunzipSync } from 'node:zlib';
import {
  getBucketForTier,
  gobdRetentionUntil,
  putObjectBytes,
  fetchObjectBytes,
} from '@taxtronik/storage';

/** Schlüssel-Schema: tenant-präfixiert für Isolation im geteilten Bucket. */
export function rawResultKey(tenantId: string, analysisId: string): string {
  return `risk-raw/${tenantId}/${analysisId}.json.gz`;
}

/** Gzip + Upload des Engine-rawResult (GoBD, Object-Lock). Liefert Bucket+Key. */
export async function storeRawResult(
  tenantId: string,
  analysisId: string,
  rawResult: unknown,
): Promise<{ bucket: string; key: string }> {
  const bucket = getBucketForTier('GOBD');
  const key = rawResultKey(tenantId, analysisId);
  const gz = gzipSync(Buffer.from(JSON.stringify(rawResult ?? null), 'utf8'));
  await putObjectBytes(bucket, key, gz, {
    contentType: 'application/gzip',
    retainUntil: gobdRetentionUntil(),
  });
  return { bucket, key };
}

/** Download + Gunzip + Parse (Forensik/Replay). */
export async function fetchRawResult(bucket: string, key: string): Promise<unknown> {
  const bytes = await fetchObjectBytes(bucket, key);
  return JSON.parse(gunzipSync(bytes).toString('utf8'));
}
