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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import {
  EvidenceService,
  LocalTimestampAdapter,
  Rfc3161HttpAdapter,
} from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';

const BACKUP_BUCKET = env.S3_BUCKET_BACKUPS ?? 'backups';

/** Buffer → Uint8Array für Prisma-Bytes-Spalten (wie audit-rotate.ts). */
function prismaBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? new Rfc3161HttpAdapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();
const evidenceService = new EvidenceService(timestampPort);

/** P-2 (wie runner.ts/restore.ts): Passwort via PGPASSWORD, nie in den Args. */
function pgConnArgs(dbUrl: string): { args: string[]; env: Record<string, string> } {
  const u = new URL(dbUrl);
  const args = [
    '-h', u.hostname,
    '-p', u.port || '5432',
    '-U', decodeURIComponent(u.username),
    '-d', u.pathname.slice(1) || decodeURIComponent(u.username),
  ];
  const e: Record<string, string> = { PGPASSWORD: decodeURIComponent(u.password) };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) e['PGSSLMODE'] = sslmode;
  return { args, env: e };
}

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

export async function runScheduledBackup(now: Date = new Date()): Promise<{ ok: boolean; key?: string; error?: string }> {
  const dumpUrl = env.DATABASE_URL;
  const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
  if (tenants.length === 0) return { ok: true }; // nichts zu sichern

  const records: BackupRecordRef[] = await Promise.all(
    tenants.map((t) => prismaOwner.backupRecord.create({ data: { tenantId: t.id, status: 'RUNNING' } })),
  );

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const key = `pgdump/${yyyy}/${mm}/${dd}/taxtronik-${yyyy}${mm}${dd}-${hh}${mi}.sql.gz`;

  let conn: { args: string[]; env: Record<string, string> };
  try {
    conn = pgConnArgs(dumpUrl);
  } catch (e) {
    const err = `DATABASE_URL nicht parsebar: ${(e as Error).message}`;
    await markAll(records, { status: 'FAILED', finishedAt: new Date(), errorMsg: err }, { status: 'FAILED', error: err });
    return { ok: false, error: err };
  }

  const args = ['--format=custom', '--no-owner', '--no-privileges', '--compress=6', ...conn.args];
  const pgDumpPath = process.env['PG_DUMP_PATH'] ?? 'pg_dump';
  const child = spawn(pgDumpPath, args, { env: { ...process.env, ...conn.env } });

  const hash = createHash('sha256');
  let sizeBytes = 0;
  let stderrBuf = '';
  child.stderr.on('data', (c: Buffer) => { stderrBuf += c.toString('utf8'); });
  const body = new PassThrough();
  child.stdout.on('data', (c: Buffer) => { hash.update(c); sizeBytes += c.length; });
  child.stdout.pipe(body);

  const exit = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));

  try {
    const upload = new Upload({
      client: s3,
      params: { Bucket: BACKUP_BUCKET, Key: key, Body: body, ContentType: 'application/octet-stream' },
      queueSize: 4,
      partSize: 5 * 1024 * 1024,
    });
    await upload.done();
    const code = await exit;
    if (code !== 0) throw new Error(`pg_dump exit ${code}: ${stderrBuf.slice(0, 1000)}`);
  } catch (e) {
    const err = `Backup fehlgeschlagen: ${(e as Error).message}`;
    // Verwaistes (evtl. unvollständiges) Objekt best-effort entfernen.
    await s3.send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key })).catch(() => undefined);
    await markAll(records, { status: 'FAILED', finishedAt: new Date(), errorMsg: err }, { status: 'FAILED', error: err });
    return { ok: false, error: err };
  }

  const sha = hash.digest();
  await markAll(
    records,
    { status: 'SUCCESS', finishedAt: new Date(), sizeBytes: BigInt(sizeBytes), bucket: BACKUP_BUCKET, key, sha256: prismaBytes(sha) },
    { status: 'SUCCESS', sizeBytes, bucket: BACKUP_BUCKET, key, sha256: sha.toString('hex') },
  );
  log.info({ key, sizeBytes }, 'backup-run: Backup erfolgreich nach S3 gestreamt');
  return { ok: true, key };
}

export const backupRunWorker = new Worker<ChecksJob>(
  'backup-run',
  async () => runScheduledBackup(),
  { connection, concurrency: 1 },
);

backupRunWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'backup-run: failed');
});
