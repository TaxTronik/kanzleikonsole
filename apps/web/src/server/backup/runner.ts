// =============================================================================
// Backup-Runner
//
// Strategie: pg_dump (komprimiert) → SHA-256 → Upload in Object-Store mit
// Object-Lock-Retention. Schreibt einen BackupRecord pro Lauf für die
// Admin-UI-Statusanzeige.
//
// Aufruf:
//   - Manuell: pnpm backup:run
//   - Cron: täglich via System-Cron oder n8n-Workflow gegen API-Endpoint
//
// Abhängigkeiten: pg_dump muss im PATH sein (oder PG_DUMP_PATH gesetzt).
//
// Hinweis: Backups werden nicht in den GoBD-Bucket geschrieben (Object-Lock
// würde sonst Backup-Rotation verhindern). Stattdessen ein eigener Bucket
// `backups` mit kurzer Retention konfigurierbar.
// =============================================================================

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { PrismaClient } from '@prisma/client';
import { env } from '@taxtronik/config';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { prismaOwner as ownerSingleton } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';

const BACKUP_BUCKET = process.env['S3_BUCKET_BACKUPS'] ?? 'backups';

/**
 * P-2: Verbindungs-URL in Args + PGPASSWORD-ENV zerlegen. spawn-Argumente
 * sind via /proc/<pid>/cmdline / `ps auxe` für andere User auf dem Host
 * sichtbar — eine vollständige `postgresql://user:pw@host/db`-URL als Arg
 * leakt das DB-Superuser-Passwort. PGPASSWORD wird hingegen nur an den
 * Child-Prozess durchgereicht und nicht in cmdline aufgeführt.
 */
function buildPgConnArgs(dbUrl: string): {
  args: string[];
  env: Record<string, string>;
} {
  const u = new URL(dbUrl);
  const args = [
    '-h', u.hostname,
    '-p', u.port || '5432',
    '-U', decodeURIComponent(u.username),
    '-d', u.pathname.slice(1) || decodeURIComponent(u.username),
  ];
  // SSL-Mode aus Query-String übernehmen, falls gesetzt (postgresql://...?sslmode=require)
  const sslmode = u.searchParams.get('sslmode');
  const env: Record<string, string> = {
    PGPASSWORD: decodeURIComponent(u.password),
  };
  if (sslmode) env.PGSSLMODE = sslmode;
  return { args, env };
}

export interface BackupResult {
  ok: boolean;
  recordId?: string;
  error?: string;
  sizeBytes?: number;
  bucket?: string;
  key?: string;
  sha256?: string;
}

/**
 * Führt ein vollständiges Postgres-Backup durch und lädt es in Object-Store.
 * Ein BackupRecord pro Tenant wird angelegt (für Admin-UI).
 *
 * NOTE: Im Single-Tenant-On-Premise-Setup ist tenantId = der einzige Tenant.
 * Der Dump enthält ALLE Daten der DB — wir verlinken ihn aber pro Tenant
 * im BackupRecord, damit jeder Tenant „sein" Backup-Status sieht.
 */
export async function runBackup(): Promise<BackupResult> {
  const prismaOwner = ownerSingleton;

  // Für alle Tenants ein RUNNING-Record anlegen
  const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
  const records = await Promise.all(
    tenants.map((t) =>
      prismaOwner.backupRecord.create({
        data: { tenantId: t.id, status: 'RUNNING' },
      }),
    ),
  );

  const dumpUrl = process.env['DATABASE_URL'] ?? '';
  if (!dumpUrl) {
    await failAll(prismaOwner, records, 'DATABASE_URL nicht gesetzt');
    return { ok: false, error: 'DATABASE_URL nicht gesetzt' };
  }

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const key = `pgdump/${yyyy}/${mm}/${dd}/taxtronik-${yyyy}${mm}${dd}-${hh}${mi}.sql.gz`;

  const pgDumpPath = process.env['PG_DUMP_PATH'] ?? 'pg_dump';

  // P-2: connection-URL parsen, Passwort in PGPASSWORD, Rest als Args
  let connArgs: ReturnType<typeof buildPgConnArgs>;
  try {
    connArgs = buildPgConnArgs(dumpUrl);
  } catch (e) {
    await failAll(prismaOwner, records, `DATABASE_URL nicht parsebar: ${(e as Error).message}`);
    return { ok: false, error: 'DATABASE_URL nicht parsebar' };
  }
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--compress=6',
    ...connArgs.args,
  ];

  // F7: pg_dump.stdout direkt zu S3 streamen — kein Buffer.concat über
  // den ganzen Dump. Hash + Größe werden via PassThrough nebenbei berechnet.
  // Reduziert Spitzenspeicher auf Multipart-Chunk-Größe (5 MB) und halbiert
  // die Wartezeit, weil Upload parallel zum Dump läuft.
  const child = spawn(pgDumpPath, args, {
    env: { ...process.env, ...connArgs.env },
  });

  const hash = createHash('sha256');
  let sizeBytes = 0;
  let stderrBuf = '';

  child.stderr.on('data', (c: Buffer) => {
    stderrBuf += c.toString('utf8');
  });

  const through = new PassThrough();
  child.stdout.on('data', (c: Buffer) => {
    hash.update(c);
    sizeBytes += c.length;
  });
  child.stdout.pipe(through);

  // Upload in Object-Store (Streaming).
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BACKUP_BUCKET,
      Key: key,
      Body: through,
      ContentType: 'application/octet-stream',
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });

  // pg_dump-Exit-Code parallel zum Upload abwarten — wenn pg_dump scheitert,
  // bricht der Pipe-Body sowieso ab und der Upload schlägt fehl.
  let dumpExitCode: number | null = null;
  child.on('exit', (code) => { dumpExitCode = code ?? -1; });

  try {
    await upload.done();
  } catch (e) {
    await failAll(prismaOwner, records, `S3-Upload fehlgeschlagen: ${(e as Error).message}`);
    return { ok: false, error: (e as Error).message };
  }

  // Warten bis pg_dump fertig ist (sollte zu diesem Zeitpunkt bereits sein).
  if (dumpExitCode === null) {
    dumpExitCode = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });
  }
  if (dumpExitCode !== 0) {
    const errMsg = `pg_dump exit ${dumpExitCode}: ${stderrBuf.slice(0, 1000)}`;
    // P-5: S3-Upload lief parallel zu pg_dump. Ist der Dump nach erfolgreichem
    // Upload mit Exit-Code ≠ 0 abgestürzt, liegt jetzt ein partieller Dump im
    // Bucket. Lifecycle-Regel räumt ihn irgendwann, bis dahin existieren aber
    // verwirrende „taxtronik-…sql.gz"-Files, die jemand versehentlich für
    // einen Restore nehmen könnte. Best-effort-Cleanup direkt.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }));
    } catch (delErr) {
      // Cleanup-Failure nicht fatal — Lifecycle räumt später. Nur ins Log.
      console.error(`[backup] Partial-Dump-Cleanup fehlgeschlagen für ${key}: ${(delErr as Error).message}`);
    }
    await failAll(prismaOwner, records, errMsg);
    return { ok: false, error: errMsg };
  }

  const sha = hash.digest();

  // Records auf SUCCESS aktualisieren. RF-12: der Backup-Lauf gehört als
  // Systemereignis in die Audit-Hash-Chain (backup.run) — in DERSELBEN Tx
  // wie das Status-Update. (Restore ist bewusst NICHT auditiert: reine CLI
  // ohne App-Kontext, siehe restore.ts.)
  await Promise.all(
    records.map((r) =>
      prismaOwner.$transaction(async (tx) => {
        await tx.backupRecord.update({
          where: { id: r.id },
          data: {
            status: 'SUCCESS',
            finishedAt: new Date(),
            sizeBytes: BigInt(sizeBytes),
            bucket: BACKUP_BUCKET,
            key,
            sha256: prismaBytes(sha),
          },
        });
        await evidenceService.record(tx, {
          tenantId: r.tenantId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'backup.run',
          resourceType: 'backup_record',
          resourceId: r.id,
          after: {
            status: 'SUCCESS',
            sizeBytes,
            bucket: BACKUP_BUCKET,
            key,
            sha256: sha.toString('hex'),
          },
        });
      }),
    ),
  );

  // Singleton: kein $disconnect.
  return {
    ok: true,
    recordId: records[0]?.id,
    sizeBytes,
    bucket: BACKUP_BUCKET,
    key,
    sha256: sha.toString('hex'),
  };
}

async function failAll(
  prismaOwner: PrismaClient,
  records: Array<{ id: string; tenantId: string }>,
  msg: string,
): Promise<void> {
  // RF-12: auch der fehlgeschlagene Lauf wird auditiert (backup.run mit
  // status FAILED) — sonst wäre ein still scheiterndes Backup unsichtbar
  // in der Chain, obwohl SYSTEM_BACKUP_FAILED-Monitoring darauf aufbaut.
  await Promise.all(
    records.map((r) =>
      prismaOwner.$transaction(async (tx) => {
        await tx.backupRecord.update({
          where: { id: r.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorMsg: msg,
          },
        });
        await evidenceService.record(tx, {
          tenantId: r.tenantId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'backup.run',
          resourceType: 'backup_record',
          resourceId: r.id,
          after: { status: 'FAILED', error: msg },
        });
      }),
    ),
  );
}

// CLI-Eintritt
async function main() {
  console.log('[backup] Starte Backup…');
  const r = await runBackup();
  if (!r.ok) {
    console.error(`[backup] FEHLER: ${r.error}`);
    process.exit(1);
  }
  console.log(`[backup] OK — ${r.sizeBytes} Bytes, sha256=${r.sha256?.slice(0, 16)}…, key=${r.key}`);
}

if (process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js')) {
  main().catch((e) => {
    console.error(`[backup] Fehler: ${(e as Error).message}`);
    process.exit(1);
  });
}
