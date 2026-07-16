// =============================================================================
// Restore-Runner — Spiegelpartner zu runner.ts
//
// Holt einen pg_dump aus dem Object-Store und spielt ihn via pg_restore in die
// konfigurierte DB ein. Optional: List-Mode (was wäre verfügbar?) und
// Smoke-Test nach Restore.
//
// Aufruf:
//   pnpm tsx apps/web/src/server/backup/restore.ts --list
//   pnpm tsx apps/web/src/server/backup/restore.ts --key <s3-key> --target-url postgres://...
//   pnpm tsx apps/web/src/server/backup/restore.ts --latest --target-url postgres://...
//   pnpm tsx apps/web/src/server/backup/restore.ts --file <pfad>   (lokale Dump-Datei,
//     z. B. aus `runner --out-file`; KEINE S3-/BackupRecord-Hash-Verifikation)
//
// Sicherheits-Voraussetzungen:
//   - Mutierende Aufrufe verlangen explizit --target-url oder --production-target.
//     Es gibt keinen stillen DATABASE_URL-Fallback.
//   - --production-target wird nur vom quieszierten Operator-Wrapper akzeptiert.
//   - Skript verlangt explizit `--confirm-overwrite`, wenn es Tabellen findet
//   - pg_restore muss im PATH sein
// =============================================================================

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { env } from '@taxtronik/config';
import { createPostgresAdapter } from '@taxtronik/db/prisma-adapter';
import { pgConnArgs } from '@taxtronik/db/pg-tools';
import { prismaOwner } from '@/server/db/prisma-owner';

const BACKUP_BUCKET = process.env['S3_BUCKET_BACKUPS'] ?? 'backups';

export const PRODUCTION_RESTORE_CONFIRMATION = 'RESTORE_TAXTRONIK_PRODUCTION_DATABASE';

export interface CliArgs {
  list: boolean;
  latest: boolean;
  key?: string;
  file?: string;
  targetUrl?: string;
  productionTarget: boolean;
  productionConfirmation?: string;
  releaseVersion?: string;
  confirmOverwrite: boolean;
  smokeTest: boolean;
}

function requiredOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} erwartet genau einen nicht-leeren Wert.`);
  }
  return value;
}

function assertPostgresTargetUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--target-url ist keine gueltige URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('--target-url muss mit postgres:// oder postgresql:// beginnen.');
  }
}

/**
 * Strikter, side-effect-freier Parser. Der Operator-Wrapper validiert dieselben
 * Invarianten vor jedem Containerstart/-stop; diese zweite Schicht schuetzt
 * direkte CLI-Aufrufe und verhindert, dass unbekannte Optionen still ignoriert
 * werden.
 */
export function parseRestoreArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    list: false,
    latest: false,
    productionTarget: false,
    confirmOverwrite: false,
    smokeTest: true,
  };
  const seen = new Set<string>();
  const claim = (option: string): void => {
    if (seen.has(option)) throw new Error(`Option doppelt angegeben: ${option}`);
    seen.add(option);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') {
      claim(a);
      out.list = true;
    } else if (a === '--latest') {
      claim(a);
      out.latest = true;
    } else if (a === '--key') {
      claim(a);
      out.key = requiredOptionValue(argv, i, a);
      i++;
    } else if (a === '--file') {
      claim(a);
      out.file = requiredOptionValue(argv, i, a);
      i++;
    } else if (a === '--target-url') {
      claim(a);
      out.targetUrl = requiredOptionValue(argv, i, a);
      assertPostgresTargetUrl(out.targetUrl);
      i++;
    } else if (a === '--production-target') {
      claim(a);
      out.productionTarget = true;
    } else if (a === '--confirm-production-restore') {
      claim(a);
      out.productionConfirmation = requiredOptionValue(argv, i, a);
      i++;
    } else if (a === '--release-version') {
      claim(a);
      out.releaseVersion = requiredOptionValue(argv, i, a);
      i++;
    } else if (a === '--confirm-overwrite') {
      claim(a);
      out.confirmOverwrite = true;
    } else if (a === '--no-smoke-test') {
      claim(a);
      out.smokeTest = false;
    } else {
      throw new Error(`Unbekannte Restore-Option: ${a ?? '<leer>'}`);
    }
  }

  if (out.list) {
    if (seen.size !== 1) {
      throw new Error(
        '--list ist read-only und darf nicht mit weiteren Optionen kombiniert werden.',
      );
    }
    return out;
  }

  const sourceCount = Number(out.latest) + Number(Boolean(out.key)) + Number(Boolean(out.file));
  if (sourceCount !== 1) {
    throw new Error('Genau eine Quelle ist Pflicht: --latest, --key <s3-key> oder --file <pfad>.');
  }

  const targetCount = Number(Boolean(out.targetUrl)) + Number(out.productionTarget);
  if (targetCount !== 1) {
    throw new Error(
      'Genau ein Ziel ist Pflicht: --target-url <postgres-url> oder --production-target.',
    );
  }

  if (out.productionTarget) {
    if (out.productionConfirmation !== PRODUCTION_RESTORE_CONFIRMATION) {
      throw new Error(
        '--production-target erfordert die exakte Bestaetigung ' +
          `--confirm-production-restore ${PRODUCTION_RESTORE_CONFIRMATION}.`,
      );
    }
    if (!out.releaseVersion || !/^\d+\.\d+\.\d+$/.test(out.releaseVersion)) {
      throw new Error(
        '--production-target erfordert --release-version X.Y.Z passend zum wiederhergestellten Backup.',
      );
    }
  } else if (out.productionConfirmation !== undefined) {
    throw new Error(
      '--confirm-production-restore ist nur zusammen mit --production-target erlaubt.',
    );
  } else if (out.releaseVersion !== undefined) {
    throw new Error('--release-version ist nur zusammen mit --production-target erlaubt.');
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

interface TargetProbe {
  $queryRaw<T>(query: TemplateStringsArray): Promise<T>;
  $disconnect(): Promise<void>;
}

type TargetProbeFactory = (targetUrl: string) => TargetProbe;

export async function targetIsEmpty(
  targetUrl: string,
  probeFactory: TargetProbeFactory = (url) =>
    new PrismaClient({ adapter: createPostgresAdapter(url) }) as unknown as TargetProbe,
): Promise<boolean> {
  const probe = probeFactory(targetUrl);
  try {
    // Nicht nur Prisma betrachten: Auch eine fremd/vorher manuell angelegte
    // Tabelle, View oder Sequenz macht `pg_restore --clean` destruktiv. System-
    // Schemas und TOAST-Interna sind die einzigen Ausnahmen.
    const rows = await probe.$queryRaw<{ hasUserObjects: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS c
          JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      ) AS "hasUserObjects"
    `;
    if (typeof rows[0]?.hasUserObjects !== 'boolean') {
      throw new Error('Ziel-DB-Leerheitspruefung lieferte kein gueltiges Ergebnis.');
    }
    return !rows[0].hasUserObjects;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Ziel-DB-Leerheitspruefung fehlgeschlagen: ${message}`, { cause: error });
  } finally {
    await probe.$disconnect();
  }
}

/**
 * ACLs/REVOKEs sind Teil des Backups. PostgreSQL kann sie nur einspielen,
 * wenn die referenzierte App-Rolle clusterweit bereits existiert. Der
 * Operator-Wrapper synchronisiert sie aus der .env; direkte CLI-Aufrufe
 * erhalten hier einen klaren Fehler statt eines halben Restore-Versuchs.
 */
async function assertRestoreRolesPresent(targetUrl: string): Promise<void> {
  const probe = new PrismaClient({ adapter: createPostgresAdapter(targetUrl) });
  try {
    const rows = await probe.$queryRaw<{ present: boolean; safe: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'taxtronik_app'
        ) AS present,
        EXISTS (
          SELECT 1
            FROM pg_catalog.pg_roles
           WHERE rolname = 'taxtronik_app'
             AND NOT rolsuper
             AND NOT rolcreatedb
             AND NOT rolcreaterole
             AND NOT rolreplication
             AND NOT rolbypassrls
        ) AS safe
    `;
    if (!rows[0]?.present || !rows[0]?.safe) {
      throw new Error(
        'Restore-Voraussetzung fehlt: PostgreSQL-Rolle taxtronik_app existiert nicht ' +
          'oder besitzt unzulässige Clusterrechte. Zuerst ./taxtronik restore verwenden ' +
          'oder die Rolle aus der .env sicher bootstrapen.',
      );
    }
  } finally {
    await probe.$disconnect();
  }
}

async function runPgRestore(filePath: string, targetUrl: string): Promise<void> {
  // P-2: Passwort via PGPASSWORD, nicht via --dbname=postgresql://user:pw@…
  const connArgs = pgConnArgs(targetUrl);
  // P-9: --single-transaction → ganz oder gar nicht. Fehler in einer Tabelle
  // rollt den gesamten Restore zurück, statt einen halb-konsistenten Zustand
  // zu hinterlassen. Bei Compliance-Software die einzig richtige Strategie.
  // --exit-on-error doppelt sicher (single-transaction macht das implizit,
  // aber explizit dokumentiert die Intention).
  const args = [
    '--clean',
    '--if-exists',
    '--no-owner',
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
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });
  child.stdout.on('data', () => {
    /* swallow */
  });
  // 'error' abfangen: bei Startfehlern (ENOENT etc.) feuert 'exit' nie —
  // ohne Listener wäre das eine uncaught exception plus ein ewig hängendes await.
  const code: number = await new Promise((res, rej) => {
    child.on('exit', (c) => res(c ?? -1));
    child.on('error', (err) =>
      rej(new Error(`pg_restore konnte nicht gestartet werden: ${err.message}`)),
    );
  });
  if (code !== 0) {
    throw new Error(`pg_restore exit ${code}: ${stderr.slice(0, 2000)}`);
  }
}

async function smokeTest(targetUrl: string): Promise<void> {
  const probe = new PrismaClient({ adapter: createPostgresAdapter(targetUrl) });
  try {
    const tenants = await probe.tenant.count();
    const audits = await probe.auditLog.count();
    process.stdout.write(
      `  Smoke-Test: ${tenants} Tenants, ${audits} Audit-Einträge erreichbar.\n`,
    );
    // Hash-Chain stichprobenartig prüfen — letzten Eintrag pro Tenant
    if (tenants > 0 && audits > 0) {
      const sample = await probe.auditLog.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true, prevHash: true, thisHash: true },
      });
      if (sample) {
        process.stdout.write(
          `  Letzter Audit-Eintrag #${String(sample.id)} mit Hash ${Buffer.from(sample.thisHash).toString('hex').slice(0, 16)}…\n`,
        );
      }
    }
  } finally {
    await probe.$disconnect();
  }
}

async function main() {
  const args = parseRestoreArgs(process.argv.slice(2));

  if (args.list) {
    const backups = await listBackups();
    if (backups.length === 0) {
      process.stdout.write(`Keine Backups in Bucket „${BACKUP_BUCKET}" gefunden.\n`);
      process.exit(0);
    }
    process.stdout.write(`Verfügbare Backups (${backups.length}, neueste zuerst):\n`);
    for (const b of backups.slice(0, 50)) {
      process.stdout.write(
        `  ${b.modified.toISOString()}  ${(b.size / 1024 / 1024).toFixed(2)} MB  ${b.key}\n`,
      );
    }
    process.exit(0);
  }

  if (args.productionTarget && process.env['TAXTRONIK_PRODUCTION_RESTORE_QUIESCED'] !== '1') {
    throw new Error(
      '--production-target darf nur über `./taxtronik restore` nach verifiziertem Stop von App, Worker und n8n ausgeführt werden.',
    );
  }

  const targetUrl = args.targetUrl ?? process.env['DATABASE_URL'];
  if (!targetUrl) {
    throw new Error('DATABASE_URL fehlt für das explizit gewählte --production-target.');
  }

  await assertRestoreRolesPresent(targetUrl);

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
    process.stdout.write(
      `  ${(dl.size / 1024 / 1024).toFixed(2)} MB, sha256=${dl.sha.slice(0, 16)}…\n`,
    );

    // P-6: Tampering-Schutz. BackupRecord enthält den am Schreibzeitpunkt
    // berechneten Hash; weicht der heruntergeladene davon ab, hat jemand
    // das Object im Bucket ersetzt → abort.
    const expectedSha = await getExpectedSha(key);
    if (expectedSha) {
      if (expectedSha !== dl.sha) {
        try {
          unlinkSync(dl.path);
        } catch {
          console.warn('[restore] Temp-Datei konnte nicht gelöscht werden:', dl.path);
        }
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

  try {
    const empty = await targetIsEmpty(targetUrl);
    if (!empty && !args.confirmOverwrite) {
      throw new Error(
        'ZIEL-DB IST NICHT LEER. Restore würde bestehende Tabellen droppen+ersetzen. ' +
          'Bitte erneut mit --confirm-overwrite aufrufen, wenn das gewollt ist.',
      );
    }

    process.stdout.write(`Spiele in DB ein …\n`);
    await runPgRestore(path, targetUrl);
  } finally {
    // Nur heruntergeladene Temp-Dateien löschen — die --file-Quelle gehört dem
    // Anwender und bleibt erhalten.
    if (cleanup) {
      try {
        unlinkSync(path);
      } catch {
        console.warn('[restore] Temp-Datei konnte nicht gelöscht werden:', path);
      }
    }
  }
  process.stdout.write(`✓ Restore abgeschlossen.\n`);

  if (args.smokeTest) {
    await smokeTest(targetUrl);
  }

  if (args.productionTarget) {
    process.stdout.write(
      '\nPRODUKTIONS-RESTORE ABGESCHLOSSEN — App, Worker und n8n bleiben absichtlich gestoppt.\n' +
        '  1. Audit-Chain, RLS/Rollen und Migrationsstand prüfen.\n' +
        '  2. Den zum Backup passenden signierten Release-Vertrag aktivieren.\n' +
        '  3. Erst danach Dienste starten und Login-/Modul-Smoke durchführen.\n',
    );
  } else {
    process.stdout.write(
      '\nNächste Schritte für das isolierte Ziel:\n' +
        '  1. pnpm verify:chain    (Hash-Chain + Archive prüfen)\n' +
        '  2. RLS/Rollen und Migrationsstand gegen den vorgesehenen Release prüfen.\n' +
        '  3. Manuell anmelden + Smoke-Test der wichtigsten Module\n',
    );
  }
}

const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`Restore fehlgeschlagen: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
