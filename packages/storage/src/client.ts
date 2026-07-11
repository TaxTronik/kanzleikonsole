import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
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
  // Explizite Socket-/Connect-Timeouts. Ohne sie kann ein hängender TCP-Socket
  // (z. B. SeaweedFS-Endpoint nicht erreichbar / gedroppte SYNs) einen SDK-Call
  // blockieren, bis das OS-Connect-Timeout (Linux ~21 s) × SDK-Retries
  // zuschlägt — in Summe deutlich >45 s ("ZUGFeRD lädt ewig"). Damit werden
  // Object-Store-Probleme schnell und diagnosable, statt den Request endlos
  // offen zu halten. connectionTimeout = TCP-Aufbau, socketTimeout = Inaktivität.
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5_000,
    socketTimeout: 30_000,
  }),
});

export function getBucketForClassification(classification: string): string {
  switch (classification) {
    case 'GOBD_INVOICE':
    case 'GOBD_CONTRACT':
    case 'GOBD_TAX':
      return env.S3_BUCKET_GOBD;
    case 'GWG_EVIDENCE':
      // B-1: Eigener Bucket — GwG-Daten haben eine fünfjährige Regelfrist;
      // andere Gesetze können länger verpflichten, spätestens nach zehn
      // Jahren ist zu vernichten (§ 8 Abs. 4 GwG). Separater Lifecycle nötig.
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
  // eine fachliche Vernichtung nach § 8 Abs. 4 GwG verhindern konnte.
  return ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'].includes(classification);
}

/**
 * B-1: GwG-Klassifikation mit fünfjähriger technischer Grundbarriere. Das
 * tatsächliche Ende wird fachlich geprüft (längere Gesetze; spätestens 10 J.).
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
      // Eigener Bucket — GwG grundsätzlich 5 J., ggf. längere andere
      // Pflichten und Vernichtung spätestens nach 10 J. (§ 8 Abs. 4 GwG);
      // separater Lifecycle gegenüber GoBD (typabhängig 6/8/10 J.).
      return env.S3_BUCKET_GWG;
    default:
      return env.S3_BUCKET_GENERAL;
  }
}
