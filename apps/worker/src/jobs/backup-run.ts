// =============================================================================
// backup-run-Worker — automatischer täglicher Postgres-Dump nach S3 (P1-24).
//
// Bisher lief das Backup NUR manuell (Admin-Button / vor Updates / ops-lib);
// ein automatischer Zeitplan fehlte. Update-los betriebene Installationen
// hatten faktisch kein aktuelles Backup — der Restore-Drill validierte dann nur
// einen uralten Stand. Dieser Job schließt die Lücke; der Staleness-Alarm in
// health-alert schlägt an, falls er ausfällt.
//
// Technik (gemeinsamer Runner mit dem Betreiber-Lauf, R-02: runPgBackup):
//   - pg_dump kommt aus dem Worker-Image (postgresql18-client, Dockerfile).
//   - pg_dump-stdout wird DIREKT als Multipart-Upload nach S3 gestreamt — KEINE
//     lokale Kopie: der Worker ist read_only, /tmp ist ein 64-MB-tmpfs (reale
//     Dumps sind größer). Die lokale Operator-Kopie (Air-Gap) bleibt Sache des
//     host-seitigen `./taxtronik backup`.
//   - SHA-256 + Größe werden beim Streamen mitgerechnet und im BackupRecord
//     verankert; jeder Lauf (Erfolg wie Fehlschlag) geht als backup.run in die
//     Audit-Hash-Chain.
//   - S-01: Installationsweite Sicherung (Wartung): Tenant-Liste,
//     Backup-Historie und Vermerke laufen über den Owner-Client.
// =============================================================================

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createWorker } from '../worker-factory';
import { env } from '@taxtronik/config';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { EvidenceService, LocalTimestampAdapter, createRfc3161Adapter } from '@taxtronik/evidence';
import { runPgBackup, streamingBackupSink } from '@taxtronik/db/pg-tools';
import { connection, type ChecksJob } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';

const BACKUP_BUCKET = env.S3_BUCKET_BACKUPS ?? 'backups';

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? createRfc3161Adapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();
const evidenceService = new EvidenceService(timestampPort);

/**
 * R-02: derselbe Runner wie der Betreiber-Lauf (`runPgBackup` aus
 * @taxtronik/db/pg-tools) — einschließlich des Zombie-Reconciles verwaister
 * RUNNING-Records (> 6 h). Der Worker streamt ohne lokale Kopie direkt nach S3.
 */
export async function runScheduledBackup(
  now: Date = new Date(),
): Promise<{ ok: boolean; key?: string; error?: string }> {
  const result = await runPgBackup({
    db: prismaOwner,
    recordAudit: (tx, entry) => evidenceService.record(tx, entry),
    sink: streamingBackupSink({
      upload: async (body, key) => {
        await new Upload({
          client: s3,
          params: {
            Bucket: BACKUP_BUCKET,
            Key: key,
            Body: body,
            ContentType: 'application/octet-stream',
          },
          queueSize: 4,
          partSize: 5 * 1024 * 1024,
        }).done();
      },
      remove: async (key) => {
        await s3.send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }));
      },
    }),
    databaseUrl: env.DATABASE_URL,
    bucket: BACKUP_BUCKET,
    now,
    // Ohne Tenant gibt es nichts zu sichern (kein Record, kein Upload).
    skipWithoutTenants: true,
    log,
  });
  if (result.ok && result.key) {
    log.info(
      { key: result.key, sizeBytes: result.sizeBytes },
      'backup-run: Backup erfolgreich nach S3 gestreamt',
    );
  }
  return {
    ok: result.ok,
    ...(result.key ? { key: result.key } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

export const backupRunWorker = createWorker<ChecksJob>(
  JOB_QUEUES.backupRun.name,
  async () => runScheduledBackup(),
  { connection, concurrency: 1 },
);
