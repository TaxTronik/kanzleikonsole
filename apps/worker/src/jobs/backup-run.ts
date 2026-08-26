// =============================================================================
// backup-run-Worker — automatischer täglicher Postgres-Dump nach S3 (P1-24).
//
// Bisher lief das Backup NUR manuell (Admin-Button / vor Updates / ops-lib);
// ein automatischer Zeitplan fehlte. Update-los betriebene Installationen
// hatten faktisch kein aktuelles Backup — der Restore-Drill validierte dann nur
// einen uralten Stand. Dieser Job schließt die Lücke; der Staleness-Alarm in
// health-alert schlägt an, falls er ausfällt.
//
// Technik (spiegelt apps/web/src/server/backup/runner.ts):
//   - pg_dump kommt aus dem Worker-Image (postgresql18-client, Dockerfile).
//   - pg_dump-stdout wird DIREKT als Multipart-Upload nach S3 gestreamt — KEINE
//     lokale Kopie: der Worker ist read_only, /tmp ist ein 64-MB-tmpfs (reale
//     Dumps sind größer). Die lokale Operator-Kopie (Air-Gap) bleibt Sache des
//     host-seitigen `./taxtronik backup`.
//   - SHA-256 + Größe werden beim Streamen mitgerechnet und im BackupRecord
//     verankert; jeder Lauf (Erfolg wie Fehlschlag) geht als backup.run in die
//     Audit-Hash-Chain.
// =============================================================================

import { randomBytes } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { EvidenceService, LocalTimestampAdapter, createRfc3161Adapter } from '@taxtronik/evidence';
import { pgConnArgs, pgDumpArgs, prismaBytes, spawnPgDump } from '@taxtronik/db/pg-tools';
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

interface BackupRecordRef {
  id: string;
  tenantId: string;
}

async function markAll(
  records: BackupRecordRef[],
  data: Parameters<typeof prismaOwner.backupRecord.update>[0]['data'],
  after: Record<string, unknown>,
): Promise<void> {
  await Promise.all(
    records.map((r) =>
      prismaOwner.$transaction(async (tx) => {
        await tx.backupRecord.update({ where: { id: r.id }, data });
        await evidenceService.record(tx, {
          tenantId: r.tenantId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'backup.run',
          resourceType: 'backup_record',
          resourceId: r.id,
          after,
        });
      }),
    ),
  );
}

/** Ab diesem Alter gilt ein RUNNING-Record als verwaist (Hard-Crash/OOM). */
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

export async function runScheduledBackup(
  now: Date = new Date(),
): Promise<{ ok: boolean; key?: string; error?: string }> {
  const dumpUrl = env.DATABASE_URL;
  const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
  if (tenants.length === 0) return { ok: true }; // nichts zu sichern

  // Zombie-Reconcile: bei SIGKILL/OOM/Stromausfall mitten im Dump bleibt ein
  // BackupRecord ewig auf RUNNING (kein markAll-Pfad greift mehr). Vor dem
  // neuen Lauf alte RUNNING-Zeilen auf FAILED setzen, damit das Admin-UI kein
  // dauerhaft „laufendes" Backup zeigt und der Zombie nicht neben dem frischen
  // Record stehen bleibt.
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS);
  const reconciled = await prismaOwner.backupRecord.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: staleBefore } },
    data: {
      status: 'FAILED',
      finishedAt: now,
      errorMsg: 'Abgebrochen (verwaister RUNNING-Record, vermutlich Prozess-Crash).',
    },
  });
  if (reconciled.count > 0) {
    log.warn(
      { count: reconciled.count },
      'backup-run: verwaiste RUNNING-Records auf FAILED gesetzt',
    );
  }

  const records: BackupRecordRef[] = await Promise.all(
    tenants.map((t) =>
      prismaOwner.backupRecord.create({
        data: { tenantId: t.id, status: 'RUNNING' },
      }),
    ),
  );

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  // Sekunden + Zufallssuffix: der manuelle Web-Trigger und dieser Worker-Job
  // laufen prozessübergreifend; bei Minutengranularität könnten sich zwei
  // parallele Läufe denselben S3-Key/Pfad überschreiben (ein Dump ginge
  // verloren, während beide Records SUCCESS meldeten).
  const rnd = randomBytes(3).toString('hex');
  const key = `pgdump/${yyyy}/${mm}/${dd}/taxtronik-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${rnd}.sql.gz`;

  let conn: { args: string[]; env: Record<string, string> };
  try {
    conn = pgConnArgs(dumpUrl);
  } catch (e) {
    const err = `DATABASE_URL nicht parsebar: ${(e as Error).message}`;
    await markAll(
      records,
      { status: 'FAILED', finishedAt: new Date(), errorMsg: err },
      { status: 'FAILED', error: err },
    );
    return { ok: false, error: err };
  }

  // ACLs sind Teil des sicherheitsrelevanten Datenbankzustands: insbesondere
  // REVOKEs auf Audit-Tabellen und SECURITY-DEFINER-Funktionen sowie die
  // gezielten Grants an taxtronik_app. Nur Ownership wird portabel gemacht;
  // Privilegien muessen im Dump erhalten bleiben.
  const dump = spawnPgDump(conn.env, pgDumpArgs(conn.args));
  let sha: Buffer;
  let sizeBytes: number;

  try {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BACKUP_BUCKET,
        Key: key,
        Body: dump.stream,
        ContentType: 'application/octet-stream',
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });
    await upload.done();
    ({ sha, sizeBytes } = await dump.result());
  } catch (e) {
    const err = `Backup fehlgeschlagen: ${(e as Error).message}`;
    // pg_dump-Prozess beenden, falls er noch läuft (z.B. Upload-Init-Fehler):
    // sonst bleibt er als Zombie hängen und hält eine DB-Connection. body
    // ebenfalls schließen, damit child.stdout nicht im Backpressure blockiert.
    dump.abort();
    // Verwaistes (evtl. unvollständiges) Objekt best-effort entfernen.
    await s3
      .send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }))
      .catch(() => undefined);
    await markAll(
      records,
      { status: 'FAILED', finishedAt: new Date(), errorMsg: err },
      { status: 'FAILED', error: err },
    );
    return { ok: false, error: err };
  }

  await markAll(
    records,
    {
      status: 'SUCCESS',
      finishedAt: new Date(),
      sizeBytes: BigInt(sizeBytes),
      bucket: BACKUP_BUCKET,
      key,
      sha256: prismaBytes(sha),
    },
    { status: 'SUCCESS', sizeBytes, bucket: BACKUP_BUCKET, key, sha256: sha.toString('hex') },
  );
  log.info({ key, sizeBytes }, 'backup-run: Backup erfolgreich nach S3 gestreamt');
  return { ok: true, key };
}

export const backupRunWorker = new Worker<ChecksJob>(
  JOB_QUEUES.backupRun.name,
  async () => runScheduledBackup(),
  { connection, concurrency: 1 },
);

backupRunWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'backup-run: failed');
});
