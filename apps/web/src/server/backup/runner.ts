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

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { env } from '@taxtronik/config';
import {
  localCopyBackupSink,
  pgConnArgs,
  pgDumpArgs,
  runPgBackup,
  spawnPgDump,
} from '@taxtronik/db/pg-tools';
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
 *
 * R-02: derselbe Runner wie der nächtliche Worker-Job (`runPgBackup` aus
 * @taxtronik/db/pg-tools), inklusive Abschluss verwaister RUNNING-Records und
 * `backup.run`-Audit je Record (RF-12) in derselben Tx wie das Status-Update.
 * Hier zusätzlich die lokale Operator-Kopie vor dem Upload.
 */
export async function runBackup(options: { singleTenantId?: string } = {}): Promise<BackupResult> {
  const prismaOwner = ownerSingleton;
  if (options.singleTenantId) {
    const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
    if (
      !matchesSingleTenantBackupScope(
        tenants.map((tenant) => tenant.id),
        options.singleTenantId,
      )
    ) {
      return { ok: false, error: 'backup_scope_not_allowed' };
    }
  }

  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  });

  // Singleton: kein $disconnect.
  return runPgBackup({
    db: prismaOwner,
    recordAudit: (tx, entry) => evidenceService.record(tx, entry),
    sink: localCopyBackupSink(
      {
        // Upload in Object-Store (Streaming aus der lokalen Operator-Kopie).
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
      },
      {
        localPathFor: ensureBackupLocalPathForKey,
        onCleanupError: (key, error) =>
          console.error(`[backup] S3-Cleanup fehlgeschlagen für ${key}: ${error.message}`),
      },
    ),
    databaseUrl: process.env['DATABASE_URL'],
    bucket: BACKUP_BUCKET,
    log: { warn: (fields, message) => console.warn(`[backup] ${message}`, fields) },
  });
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
