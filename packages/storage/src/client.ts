import { S3Client } from '@aws-sdk/client-s3';
import { env } from '@taxtronik/config';

// Singleton S3-Client (forcePathStyle = true, weil On-Prem-Engine wie
// SeaweedFS pfadbasierte Bucket-URLs erwartet — AWS SDK würde sonst
// Virtual-Hosted-Style nutzen, der hier nicht funktioniert).
//
// `requestChecksumCalculation: 'WHEN_REQUIRED'` — wichtig für Browser-Upload
// via presigned URL: Default seit AWS SDK v3.729 ist 'WHEN_SUPPORTED', das
// hängt einen `x-amz-checksum-*`- (bzw. Content-MD5-)Header in die Signatur
// hinein. SeaweedFS verlangt diesen Header beim PUT — der Browser kann ihn
// aber nicht setzen (Stream-Body, keine Vorabprüfsumme), und es kommt zu
// 400 BadDigest. WHEN_REQUIRED erzwingt die Checksum nur, wenn der Service
// es explizit verlangt (S3 Express o. ä.) — fürs normale PUT bleibt sie aus.
// Singleton S3-Client — App/Worker ↔ SeaweedFS ausschließlich über das
// interne Docker-Netz. Der Object-Store ist NIE öffentlich erreichbar
// (§ 203 StGB, minimale Angriffsfläche on-prem); Uploads/Downloads werden
// von der App selbst gestreamt, kein presigned-direct mehr.
export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export function getBucketForClassification(classification: string): string {
  switch (classification) {
    case 'GOBD_INVOICE':
    case 'GOBD_CONTRACT':
    case 'GOBD_TAX':
      return env.S3_BUCKET_GOBD;
    case 'GWG_EVIDENCE':
      // B-1: Eigener Bucket — GwG-Daten haben 5-Jahre-Höchstaufbewahrung
      // (§ 8 Abs. 4 GwG), nicht 10 wie GoBD. Separater Lifecycle nötig.
      return env.S3_BUCKET_GWG;
    case 'STAFF_PRIVATE':
      return env.S3_BUCKET_STAFF_PRIVATE;
    default:
      return env.S3_BUCKET_GENERAL;
  }
}

export function isGobdClassification(classification: string): boolean {
  // B-1: GWG_EVIDENCE BEWUSST NICHT mehr GoBD-pflichtig markiert. Vorher
  // landete GWG_EVIDENCE im gobd-Bucket mit 10-Jahre-COMPLIANCE-Lock, was
  // gegen § 8 Abs. 4 GwG (5-Jahre-Maximum) verstößt.
  return ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'].includes(classification);
}

/**
 * B-1: Klassifikationen mit verkürzter Aufbewahrung (5 Jahre, § 8 Abs. 4 GwG).
 * Diese Klasse kriegt einen eigenen Bucket mit eigenem Retain-Until-Datum.
 */
export function isGwgClassification(classification: string): boolean {
  return classification === 'GWG_EVIDENCE';
}

// ---------------------------------------------------------------------------
// Schutzstufen (iter55). Die Stufe — nicht mehr die rohe Klassifikation —
// treibt Bucket + Object-Lock + Aufbewahrung. Genau drei, fix.
// ---------------------------------------------------------------------------
export type ProtectionTier = 'NONE' | 'GWG' | 'GOBD';

/** Gesetzlich fixes Mapping der 7 Kern-Typen → Schutzstufe (Back-Compat /
 *  Altbestand ohne documentType). */
export function classificationToTier(classification: string): ProtectionTier {
  if (isGobdClassification(classification)) return 'GOBD';
  if (isGwgClassification(classification)) return 'GWG';
  return 'NONE';
}

export function getBucketForTier(tier: ProtectionTier): string {
  switch (tier) {
    case 'GOBD':
      return env.S3_BUCKET_GOBD;
    case 'GWG':
      // Eigener Bucket — GwG-Höchstaufbewahrung 5 J. (§ 8 Abs. 4 GwG),
      // separater Lifecycle gegenüber GoBD (10 J.).
      return env.S3_BUCKET_GWG;
    default:
      return env.S3_BUCKET_GENERAL;
  }
}
