// =============================================================================
// Backup-Runner
//
// Strategie: pg_dump (komprimiert) → lokale Operator-Kopie → SHA-256 → Upload
// in Object-Store mit Object-Lock-Retention. Schreibt einen BackupRecord pro
// Lauf für die Admin-UI-Statusanzeige.
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

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { PrismaClient } from '@prisma/client';
import { env } from '@taxtronik/config';
import { pgConnArgs, pgDumpArgs, prismaBytes, spawnPgDump } from '@taxtronik/db/pg-tools';
import { prismaOwner as ownerSingleton } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';
import { ensureBackupLocalPathForKey } from './local-path';
import { matchesSingleTenantBackupScope } from './scope';

const BACKUP_BUCKET = process.env['S3_BUCKET_BACKUPS'] ?? 'backups';

export interface BackupResult {
  ok: boolean;
  recordId?: string;
  error?: string;
  sizeBytes?: number;
  bucket?: string;
  key?: string;
  sha256?: string;
  localPath?: string;
}

/**
 * Führt ein vollständiges Postgres-Backup durch und lädt es in Object-Store.
 * Ein BackupRecord pro Tenant wird angelegt (für Admin-UI).
 *
 * NOTE: Im Single-Tenant-On-Premise-Setup ist tenantId = der einzige Tenant.
 * Der Dump enthält ALLE Daten der DB — wir verlinken ihn aber pro Tenant
 * im BackupRecord, damit jeder Tenant „sein" Backup-Status sieht.
 */
export async function runBackup(options: { singleTenantId?: string } = {}): Promise<BackupResult> {
  const prismaOwner = ownerSingleton;

  // Für alle Tenants ein RUNNING-Record anlegen
  const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
  if (
    options.singleTenantId &&
    !matchesSingleTenantBackupScope(
      tenants.map((tenant) => tenant.id),
      options.singleTenantId,
    )
  ) {
    return { ok: false, error: 'backup_scope_not_allowed' };
  }
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
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  // Sekunden + Zufallssuffix gegen Key-Kollision: dieser manuelle Lauf und der
  // Worker-Backup-Job laufen prozessübergreifend — bei Minutengranularität
  // könnten sich zwei parallele Läufe denselben S3-Key/Pfad überschreiben.
  const rnd = randomBytes(3).toString('hex');
  const key = `pgdump/${yyyy}/${mm}/${dd}/taxtronik-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${rnd}.sql.gz`;

  // P-2: connection-URL parsen, Passwort in PGPASSWORD, Rest als Args
  let connArgs: ReturnType<typeof pgConnArgs>;
  try {
    connArgs = pgConnArgs(dumpUrl);
  } catch (e) {
    await failAll(prismaOwner, records, `DATABASE_URL nicht parsebar: ${(e as Error).message}`);
    return { ok: false, error: 'DATABASE_URL nicht parsebar' };
  }
  const args = pgDumpArgs(connArgs.args);

  let localPath: string;
  try {
    localPath = await ensureBackupLocalPathForKey(key);
  } catch (e) {
    const errMsg = `Lokaler Backup-Pfad nicht bereit: ${(e as Error).message}`;
    await failAll(prismaOwner, records, errMsg);
    return { ok: false, error: errMsg };
  }

  const dump = spawnPgDump(connArgs.env, args);

  try {
    await pipeline(dump.stream, createWriteStream(localPath, { mode: 0o600 }));
  } catch (e) {
    dump.abort();
    await dump.result().catch(() => undefined);
    const errMsg = `Lokaler Backup-Write fehlgeschlagen: ${(e as Error).message}`;
    await unlink(localPath).catch(() => undefined);
    await failAll(prismaOwner, records, errMsg);
    return { ok: false, error: errMsg };
  }

  let sha: Buffer;
  let sizeBytes: number;
  try {
    ({ sha, sizeBytes } = await dump.result());
  } catch (e) {
    const errMsg = (e as Error).message;
    await unlink(localPath).catch(() => undefined);
    await failAll(prismaOwner, records, errMsg);
    return { ok: false, error: errMsg };
  }

  // Upload in Object-Store (Streaming aus der lokalen Operator-Kopie).
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
      Body: createReadStream(localPath),
      ContentType: 'application/octet-stream',
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });

  try {
    await upload.done();
  } catch (e) {
    const errMsg = `S3-Upload fehlgeschlagen: ${(e as Error).message}`;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }));
    } catch (delErr) {
      console.error(`[backup] S3-Cleanup fehlgeschlagen für ${key}: ${(delErr as Error).message}`);
    }
    await failAll(prismaOwner, records, errMsg);
    return { ok: false, error: errMsg };
  }

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
            localPath,
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
    localPath,
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

/**
 * Reiner Dump-Export in eine lokale Datei (--out-file / BACKUP_OUT_FILE).
 *
 * Bewusst OHNE S3, OHNE BackupRecord, OHNE backup.run-Audit — es ist ein
 * Datei-Sink für Air-Gapped-Transfer und für den automatisierten
 * Restore-Selbsttest (CI). Verwendet aber EXAKT dieselbe pg_dump-Arg-Liste
 * und Stream/Hash-Logik wie der S3-Pfad (DRY), damit der echte Dump-Code
 * getestet wird. Datei wird mit Mode 0o600 angelegt (Passwort-Hashes!).
 */
async function dumpToFile(outFile: string): Promise<BackupResult> {
  const dumpUrl = process.env['DATABASE_URL'] ?? '';
  if (!dumpUrl) {
    return { ok: false, error: 'DATABASE_URL nicht gesetzt' };
  }
  let connArgs: ReturnType<typeof pgConnArgs>;
  try {
    connArgs = pgConnArgs(dumpUrl);
  } catch (e) {
    return { ok: false, error: `DATABASE_URL nicht parsebar: ${(e as Error).message}` };
  }
  const args = pgDumpArgs(connArgs.args);

  const dump = spawnPgDump(connArgs.env, args);

  // Stream → lokale Datei (Mode 0o600). Hash + Größe laufen über das
  // PassThrough nebenher und stehen nach result() bereit.
  try {
    await pipeline(dump.stream, createWriteStream(outFile, { mode: 0o600 }));
  } catch (e) {
    dump.abort();
    await dump.result().catch(() => undefined);
    return {
      ok: false,
      error: `Schreiben nach ${outFile} fehlgeschlagen: ${(e as Error).message}`,
    };
  }

  let sha: Buffer;
  let sizeBytes: number;
  try {
    ({ sha, sizeBytes } = await dump.result());
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  return { ok: true, sizeBytes, sha256: sha.toString('hex') };
}

// CLI-Eintritt
async function main() {
  // --out-file / BACKUP_OUT_FILE: reiner lokaler Dump-Export (kein S3/Record).
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf('--out-file');
  const outFile = flagIdx >= 0 ? argv[flagIdx + 1] : process.env['BACKUP_OUT_FILE'];
  if (outFile) {
    console.log(`[backup] Dump-Export nach ${outFile} (lokal, kein S3/Record)…`);
    const r = await dumpToFile(outFile);
    if (!r.ok) {
      console.error(`[backup] FEHLER: ${r.error}`);
      process.exit(1);
    }
    console.log(
      `[backup] OK — ${r.sizeBytes} Bytes, sha256=${r.sha256?.slice(0, 16)}…, datei=${outFile}`,
    );
    return;
  }

  console.log('[backup] Starte Backup…');
  const r = await runBackup();
  if (!r.ok) {
    console.error(`[backup] FEHLER: ${r.error}`);
    process.exit(1);
  }
  console.log(
    `[backup] OK — ${r.sizeBytes} Bytes, sha256=${r.sha256?.slice(0, 16)}…, key=${r.key}, lokal=${r.localPath}`,
  );
}

if (process.argv[1]?.endsWith('runner.ts') || process.argv[1]?.endsWith('runner.js')) {
  main().catch((e) => {
    console.error(`[backup] Fehler: ${(e as Error).message}`);
    process.exit(1);
  });
}
