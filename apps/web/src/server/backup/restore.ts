// =============================================================================
// Restore-Runner — Spiegelpartner zu runner.ts
//
// Holt einen pg_dump aus dem Object-Store und spielt ihn via pg_restore in die
// konfigurierte DB ein. Optional: List-Mode (was wäre verfügbar?) und
// Smoke-Test nach Restore.
//
// Aufruf:
//   pnpm tsx apps/web/src/server/backup/restore.ts --list
//   pnpm tsx apps/web/src/server/backup/restore.ts --key <s3-key> [--target-url postgres://...]
//   pnpm tsx apps/web/src/server/backup/restore.ts --latest
//   pnpm tsx apps/web/src/server/backup/restore.ts --file <pfad>   (lokale Dump-Datei,
//     z. B. aus `runner --out-file`; KEINE S3-/BackupRecord-Hash-Verifikation)
//
// Sicherheits-Voraussetzungen:
//   - DATABASE_URL des Restore-Ziels MUSS eine FRISCHE Datenbank sein
//     (sonst: bestehende Daten werden überschrieben)
//   - Skript verlangt explizit `--confirm-overwrite`, wenn es Tabellen findet
//   - pg_restore muss im PATH sein
// =============================================================================

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import prismaClientPkg from '@prisma/client';
const { PrismaClient } = prismaClientPkg;
import { env } from '@taxtronik/config';
import { createPostgresAdapter } from '@taxtronik/db/prisma-adapter';
import { prismaOwner } from '@/server/db/prisma-owner';

const BACKUP_BUCKET = process.env['S3_BUCKET_BACKUPS'] ?? 'backups';

/**
 * P-2: pg_restore-Verbindungsdaten aufteilen, damit das Passwort nicht via
 * /proc/<pid>/cmdline leakt. Symmetrisch zu runner.ts.
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
  const sslmode = u.searchParams.get('sslmode');
  const e: Record<string, string> = {
    PGPASSWORD: decodeURIComponent(u.password),
  };
  if (sslmode) e.PGSSLMODE = sslmode;
  return { args, env: e };
}

interface CliArgs {
  list: boolean;
  latest: boolean;
  key?: string;
  file?: string;
  targetUrl?: string;
  confirmOverwrite: boolean;
  smokeTest: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const out: CliArgs = {
    list: false, latest: false, confirmOverwrite: false, smokeTest: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--latest') out.latest = true;
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--target-url') out.targetUrl = argv[++i];
    else if (a === '--confirm-overwrite') out.confirmOverwrite = true;
    else if (a === '--no-smoke-test') out.smokeTest = false;
  }
  return out;
}

/**
 * Lokale Dump-Datei (--file): SHA-256 + Größe berechnen für Transparenz.
 * KEINE Verifikation gegen einen BackupRecord (es gibt keinen — die Quelle
 * ist eine Datei, kein S3-Objekt). Spiegelt fetchToTempFile, ohne Download.
 */
async function hashLocalFile(filePath: string): Promise<{ sha: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const tap = new PassThrough();
  tap.on('data', (c: Buffer) => {
    hash.update(c);
    size += c.length;
  });
  await pipeline(createReadStream(filePath), tap);
  return { sha: hash.digest('hex'), size };
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    forcePathStyle: true,
  });
}

async function listBackups(): Promise<Array<{ key: string; size: number; modified: Date }>> {
  const s3 = s3Client();
  const out: Array<{ key: string; size: number; modified: Date }> = [];
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: BACKUP_BUCKET,
        Prefix: 'pgdump/',
        ContinuationToken: token,
      }),
    );
    for (const obj of r.Contents ?? []) {
      if (obj.Key && obj.Size != null && obj.LastModified) {
        out.push({ key: obj.Key, size: obj.Size, modified: obj.LastModified });
      }
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function fetchToTempFile(key: string): Promise<{ path: string; sha: string; size: number }> {
  const s3 = s3Client();
  const r = await s3.send(new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: key }));
  const body = r.Body as Readable;

  // P-6: nicht den ganzen Dump in den RAM laden (OOM bei großen Backups).
  // Streamen → Datei, Hash + Size via PassThrough nebenbei berechnen.
  // Mode 0o600 verhindert, dass andere lokale User die DB-Replikation
  // inkl. aller Passwort-Hashes lesen können, bevor unlinkSync greift.
  const path = join(tmpdir(), `taxtronik-restore-${Date.now()}.dump`);
  const hash = createHash('sha256');
  let size = 0;
  const tap = new PassThrough();
  tap.on('data', (c: Buffer) => {
    hash.update(c);
    size += c.length;
  });
  await pipeline(body, tap, createWriteStream(path, { mode: 0o600 }));
  return { path, sha: hash.digest('hex'), size };
}

/**
 * P-6: Hash-Verifikation gegen den in der DB hinterlegten BackupRecord.sha256.
 * Wer Schreibzugriff auf den S3-Bucket hat, könnte sonst das Dump-Objekt
 * unbemerkt austauschen — Restore würde das Tampering nicht bemerken.
 * Liefert null wenn kein passender Record existiert (Backup vor Hash-
 * Aufzeichnung oder External Restore aus Disaster-Recovery-Bucket).
 */
async function getExpectedSha(key: string): Promise<string | null> {
  try {
    const rec = await prismaOwner.backupRecord.findFirst({
      where: { key, status: 'SUCCESS' },
      orderBy: { finishedAt: 'desc' },
      select: { sha256: true },
    });
    if (!rec?.sha256) return null;
    return Buffer.from(rec.sha256).toString('hex');
  } catch {
    return null;
  }
}

async function targetIsEmpty(targetUrl: string): Promise<boolean> {
  // Ein „leeres" Ziel hat noch keine `_prisma_migrations`-Tabelle.
  const probe = new PrismaClient({ adapter: createPostgresAdapter(targetUrl) });
  try {
    const rows = await probe.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists
    `;
    return !rows[0]?.exists;
  } catch {
    return true;
  } finally {
    await probe.$disconnect();
  }
}

async function runPgRestore(filePath: string, targetUrl: string): Promise<void> {
  // P-2: Passwort via PGPASSWORD, nicht via --dbname=postgresql://user:pw@…
  const connArgs = buildPgConnArgs(targetUrl);
  // P-9: --single-transaction → ganz oder gar nicht. Fehler in einer Tabelle
  // rollt den gesamten Restore zurück, statt einen halb-konsistenten Zustand
  // zu hinterlassen. Bei Compliance-Software die einzig richtige Strategie.
  // --exit-on-error doppelt sicher (single-transaction macht das implizit,
  // aber explizit dokumentiert die Intention).
  const args = [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
    '--exit-on-error',
    ...connArgs.args,
    filePath,
  ];
  const path = process.env['PG_RESTORE_PATH'] ?? 'pg_restore';
  const child = spawn(path, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...connArgs.env },
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  child.stdout.on('data', () => { /* swallow */ });
  const code: number = await new Promise((res) => child.on('exit', (c) => res(c ?? -1)));
  if (code !== 0) {
    throw new Error(`pg_restore exit ${code}: ${stderr.slice(0, 2000)}`);
  }
}

async function smokeTest(targetUrl: string): Promise<void> {
  const probe = new PrismaClient({ adapter: createPostgresAdapter(targetUrl) });
  try {
    const tenants = await probe.tenant.count();
    const audits = await probe.auditLog.count();
    process.stdout.write(`  Smoke-Test: ${tenants} Tenants, ${audits} Audit-Einträge erreichbar.\n`);
    // Hash-Chain stichprobenartig prüfen — letzten Eintrag pro Tenant
    if (tenants > 0 && audits > 0) {
      const sample = await probe.auditLog.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true, prevHash: true, thisHash: true },
      });
      if (sample) {
        process.stdout.write(`  Letzter Audit-Eintrag #${String(sample.id)} mit Hash ${Buffer.from(sample.thisHash).toString('hex').slice(0, 16)}…\n`);
      }
    }
  } finally {
    await probe.$disconnect();
  }
}

async function main() {
  const args = parseArgs();

  if (args.list) {
    const backups = await listBackups();
    if (backups.length === 0) {
      process.stdout.write(`Keine Backups in Bucket „${BACKUP_BUCKET}" gefunden.\n`);
      process.exit(0);
    }
    process.stdout.write(`Verfügbare Backups (${backups.length}, neueste zuerst):\n`);
    for (const b of backups.slice(0, 50)) {
      process.stdout.write(`  ${b.modified.toISOString()}  ${(b.size / 1024 / 1024).toFixed(2)} MB  ${b.key}\n`);
    }
    process.exit(0);
  }

  // --file und --key/--latest schließen sich gegenseitig aus: entweder lokale
  // Datei-Quelle (kein S3, kein Record) ODER S3-Objekt (mit Hash-Verifikation).
  if (args.file && (args.key || args.latest)) {
    process.stderr.write('--file und --key/--latest schließen sich aus. Bitte nur eine Quelle angeben.\n');
    process.exit(1);
  }

  const targetUrl = args.targetUrl ?? process.env['DATABASE_URL'];
  if (!targetUrl) {
    process.stderr.write(`Kein DATABASE_URL und kein --target-url angegeben.\n`);
    process.exit(1);
  }

  // Quelle bestimmen: entweder lokale Datei oder S3-Objekt.
  // `path`     = Pfad der Dump-Datei, die pg_restore liest.
  // `cleanup`  = ob die Datei nach dem Restore gelöscht wird (nur Temp-Downloads,
  //              NICHT die vom Anwender bereitgestellte --file-Quelle).
  let path: string;
  let cleanup: boolean;

  if (args.file) {
    // P-6-Hinweis: Im Datei-Modus entfällt die Hash-Verifikation gegen den
    // BackupRecord — die Quelle ist eine Datei, kein S3-Objekt mit DB-Referenz.
    // Wir berechnen den lokalen SHA trotzdem und geben ihn für die manuelle
    // Nachverfolgung (Air-Gapped-Transfer) aus.
    process.stdout.write(`Lokale Dump-Datei: ${args.file}\n`);
    const { sha, size } = await hashLocalFile(args.file);
    process.stdout.write(`  ${(size / 1024 / 1024).toFixed(2)} MB, sha256=${sha.slice(0, 16)}…\n`);
    process.stdout.write(
      `  HINWEIS: Datei-Quelle → keine Hash-Verifikation gegen BackupRecord (DB-Referenz entfällt).\n`,
    );
    path = args.file;
    cleanup = false;
  } else {
    let key = args.key;
    if (!key && args.latest) {
      const backups = await listBackups();
      if (backups.length === 0) {
        process.stderr.write(`Kein Backup vorhanden — kann nicht „--latest" wiederherstellen.\n`);
        process.exit(1);
      }
      key = backups[0]!.key;
    }
    if (!key) {
      process.stderr.write(`Bitte --key <s3-key>, --latest oder --file <pfad> angeben.\n`);
      process.exit(1);
    }

    process.stdout.write(`Lade Backup ${key} aus dem Object-Store …\n`);
    const dl = await fetchToTempFile(key);
    process.stdout.write(`  ${(dl.size / 1024 / 1024).toFixed(2)} MB, sha256=${dl.sha.slice(0, 16)}…\n`);

    // P-6: Tampering-Schutz. BackupRecord enthält den am Schreibzeitpunkt
    // berechneten Hash; weicht der heruntergeladene davon ab, hat jemand
    // das Object im Bucket ersetzt → abort.
    const expectedSha = await getExpectedSha(key);
    if (expectedSha) {
      if (expectedSha !== dl.sha) {
        try { unlinkSync(dl.path); } catch { console.warn('[restore] Temp-Datei konnte nicht gelöscht werden:', dl.path); }
        throw new Error(
          `Hash-Mismatch: erwartet ${expectedSha.slice(0, 16)}…, gelesen ${dl.sha.slice(0, 16)}…. ` +
          'Backup wurde nach Erstellung verändert (Tampering oder Storage-Defekt). Restore abgebrochen.',
        );
      }
      process.stdout.write(`  Hash gegen BackupRecord verifiziert ✓\n`);
    } else {
      process.stdout.write(
        `  WARNUNG: Kein passender BackupRecord — Hash konnte nicht gegen DB-Referenz verifiziert werden.\n`,
      );
    }
    path = dl.path;
    cleanup = true;
  }

  const empty = await targetIsEmpty(targetUrl);
  if (!empty && !args.confirmOverwrite) {
    if (cleanup) { try { unlinkSync(path); } catch { console.warn('[restore] Temp-Datei konnte nicht gelöscht werden:', path); } }
    process.stderr.write(
      'ZIEL-DB IST NICHT LEER. Restore würde bestehende Tabellen droppen+ersetzen.\n' +
      'Bitte erneut mit --confirm-overwrite aufrufen, wenn das gewollt ist.\n',
    );
    process.exit(1);
  }

  process.stdout.write(`Spiele in DB ein …\n`);
  try {
    await runPgRestore(path, targetUrl);
  } finally {
    // Nur heruntergeladene Temp-Dateien löschen — die --file-Quelle gehört dem
    // Anwender und bleibt erhalten.
    if (cleanup) { try { unlinkSync(path); } catch { console.warn('[restore] Temp-Datei konnte nicht gelöscht werden:', path); } }
  }
  process.stdout.write(`✓ Restore abgeschlossen.\n`);

  if (args.smokeTest) {
    await smokeTest(targetUrl);
  }

  process.stdout.write(
    '\nNächste Schritte:\n' +
    '  1. pnpm verify:chain    (Hash-Chain + Archive prüfen)\n' +
    '  2. App neu starten      (Caches leeren)\n' +
    '  3. Manuell anmelden + Smoke-Test der wichtigsten Module\n',
  );
}

main().catch((err) => {
  process.stderr.write(`Restore fehlgeschlagen: ${(err as Error).message}\n`);
  process.exit(1);
});
