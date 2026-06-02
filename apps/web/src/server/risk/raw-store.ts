// =============================================================================
// rawResult-Ablage im Object-Store (SeaweedFS) statt in Postgres.
//
// Der vollständige Engine-Output (`rawResult`) ist reines Write-Only-Kaltarchiv
// (Audit/Replay) — zur Laufzeit liest ihn keine Funktion. In Postgres war er der
// größte Einzelposten (~⅓ der Analyse). Daher: gzip → SeaweedFS (NONE-Tier,
// app-proxied, nie öffentlich), nur Bucket/Key liegen auf RiskAnalysis.
// =============================================================================

import { gzipSync, gunzipSync } from 'node:zlib';
import { getBucketForTier, putObjectBytes, fetchObjectBytes } from '@taxtronik/storage';

/** Schlüssel-Schema: tenant-präfixiert für Isolation im geteilten Bucket. */
export function rawResultKey(tenantId: string, analysisId: string): string {
  return `risk-raw/${tenantId}/${analysisId}.json.gz`;
}

/** Gzip + Upload des Engine-rawResult. Liefert Bucket+Key für die Referenz. */
export async function storeRawResult(
  tenantId: string,
  analysisId: string,
  rawResult: unknown,
): Promise<{ bucket: string; key: string }> {
  const bucket = getBucketForTier('NONE');
  const key = rawResultKey(tenantId, analysisId);
  const gz = gzipSync(Buffer.from(JSON.stringify(rawResult ?? null), 'utf8'));
  await putObjectBytes(bucket, key, gz, 'application/gzip');
  return { bucket, key };
}

/** Download + Gunzip + Parse (Forensik/Replay). */
export async function fetchRawResult(bucket: string, key: string): Promise<unknown> {
  const bytes = await fetchObjectBytes(bucket, key);
  return JSON.parse(gunzipSync(bytes).toString('utf8'));
}
