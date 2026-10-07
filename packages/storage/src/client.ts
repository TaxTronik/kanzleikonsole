import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { storageConfig } from './config';
import type { ProtectionTier } from './tiers';

// Reine Schutzstufen-Regeln liegen ENV-frei in ./tiers (auch für Client-Bundles).
export {
  classificationToTier,
  documentTier,
  isGobdClassification,
  isGwgClassification,
  type ProtectionTier,
} from './tiers';

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
//
// K-09: Der Client entsteht beim ersten Zugriff, nicht beim Import des Pakets
// (Konfiguration und Fehler: ./config.ts).
let client: S3Client | undefined;

/** Der S3-Client des Prozesses; beim ersten Aufruf aus der Konfiguration erzeugt. */
export function getS3Client(): S3Client {
  if (client) return client;
  const config = storageConfig();
  client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
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
  return client;
}

/**
 * Gemeinsamer Zugang `s3.send(command)` wie bisher. Der erste Aufruf erzeugt
 * den Client (getS3Client). Fehlt die S3-Konfiguration oder ist sie ungültig,
 * endet der Aufruf mit dem Fehler der ENV-Validierung als abgelehntes Promise,
 * wie jeder andere Sendefehler.
 */
export const s3: Pick<S3Client, 'send'> = {
  send: ((...args: Parameters<S3Client['send']>) => {
    let target: S3Client;
    try {
      target = getS3Client();
    } catch (error) {
      return Promise.reject(error);
    }
    return target.send(...args);
  }) as S3Client['send'],
};

export function getBucketForClassification(classification: string): string {
  switch (classification) {
    case 'GOBD_INVOICE':
    case 'GOBD_CONTRACT':
    case 'GOBD_TAX':
      return storageConfig().S3_BUCKET_GOBD;
    case 'GWG_EVIDENCE':
      // B-1: Eigener Bucket — GwG-Daten haben eine fünfjährige Regelfrist;
      // andere Gesetze können länger verpflichten, spätestens nach zehn
      // Jahren ist zu vernichten (§ 8 Abs. 4 GwG). Separater Lifecycle nötig.
      return storageConfig().S3_BUCKET_GWG;
    case 'STAFF_PRIVATE':
      return storageConfig().S3_BUCKET_STAFF_PRIVATE;
    default:
      return storageConfig().S3_BUCKET_GENERAL;
  }
}

export function getBucketForTier(tier: ProtectionTier): string {
  switch (tier) {
    case 'GOBD':
      return storageConfig().S3_BUCKET_GOBD;
    case 'GWG':
      // Eigener Bucket — GwG grundsätzlich 5 J., ggf. längere andere
      // Pflichten und Vernichtung spätestens nach 10 J. (§ 8 Abs. 4 GwG);
      // separater Lifecycle gegenüber GoBD (typabhängig 6/8/10 J.).
      return storageConfig().S3_BUCKET_GWG;
    default:
      return storageConfig().S3_BUCKET_GENERAL;
  }
}
