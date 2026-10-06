import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Prisma } from '@prisma/client';

export interface PgConnectionArgs {
  args: string[];
  env: Record<string, string>;
}

/** Keep PostgreSQL passwords out of process arguments and process listings. */
export function pgConnArgs(dbUrl: string): PgConnectionArgs {
  const url = new URL(dbUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL-URL erwartet.');
  }
  const username = decodeURIComponent(url.username);
  const args = [
    '-h',
    url.hostname,
    '-p',
    url.port || '5432',
    '-U',
    username,
    '-d',
    url.pathname.slice(1) ? decodeURIComponent(url.pathname.slice(1)) : username,
  ];
  const env: Record<string, string> = { PGPASSWORD: decodeURIComponent(url.password) };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env['PGSSLMODE'] = sslmode;
  return { args, env };
}

export function pgDumpArgs(connectionArgs: readonly string[]): string[] {
  return ['--format=custom', '--no-owner', '--compress=6', ...connectionArgs];
}

export interface PgDumpResult {
  sha: Buffer;
  sizeBytes: number;
}

export interface PgDumpProcess {
  stream: PassThrough;
  result: () => Promise<PgDumpResult>;
  abort: () => void;
}

/**
 * Starts pg_dump once and exposes a sink-neutral byte stream. Hashing, byte
 * counting, stderr limiting and ENOENT handling are shared by web and worker.
 */
export function spawnPgDump(
  connectionEnv: Record<string, string>,
  args: readonly string[],
  options: {
    path?: string;
    parentEnv?: NodeJS.ProcessEnv;
  } = {},
): PgDumpProcess {
  const child = spawn(options.path ?? process.env['PG_DUMP_PATH'] ?? 'pg_dump', [...args], {
    env: { ...(options.parentEnv ?? process.env), ...connectionEnv },
  });
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let stderr = '';
  let spawnError: Error | null = null;

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 1_000) stderr += chunk.toString('utf8').slice(0, 1_000 - stderr.length);
  });
  const stream = new PassThrough();
  child.stdout.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    sizeBytes += chunk.length;
  });
  child.stdout.pipe(stream);

  let settle!: (code: number) => void;
  let settled = false;
  const completion = new Promise<number>((resolve) => {
    settle = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
  });
  child.on('close', (code) => settle(code ?? -1));
  child.on('error', (error) => {
    spawnError = error;
    stream.destroy(error);
    settle(-1);
  });

  let resultPromise: Promise<PgDumpResult> | undefined;
  return {
    stream,
    result: () => {
      resultPromise ??= completion.then((code) => {
        if (spawnError) {
          throw new Error(`pg_dump konnte nicht gestartet werden: ${spawnError.message}`);
        }
        if (code !== 0) throw new Error(`pg_dump exit ${code}: ${stderr}`);
        return { sha: hash.digest(), sizeBytes };
      });
      return resultPromise;
    },
    abort: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!stream.destroyed) stream.destroy();
    },
  };
}

export function prismaBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

// ---------------------------------------------------------------------------
// pg_restore (R-02): Produktiv-Restore (apps/web/src/server/backup/restore.ts)
// und Restore-Drill (apps/worker/src/jobs/backup-drill.ts) verwenden EINE
// Flag-Liste — vorher zwei Kopien, synchron gehalten nur per Kommentar.
// ---------------------------------------------------------------------------

/**
 * `--clean --if-exists`: Zielobjekte vor dem Neuanlegen entfernen.
 * `--no-owner`: nur Ownership portabel; ACLs/REVOKEs (Audit-Tabellen,
 * SECURITY-DEFINER-Funktionen, Grants an taxtronik_app) bleiben Teil des
 * wiederhergestellten Sicherheitszustands. `--single-transaction` (P-9): ganz
 * oder gar nicht; `--exit-on-error` dokumentiert die Absicht ausdrücklich.
 */
export function pgRestoreArgs(connectionArgs: readonly string[], dumpPath: string): string[] {
  return [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--single-transaction',
    '--exit-on-error',
    ...connectionArgs,
    dumpPath,
  ];
}

// ---------------------------------------------------------------------------
// Backup-Lauf (R-02): EIN Runner für den Betreiber-Lauf (`pnpm backup:run`,
// apps/web/src/server/backup/runner.ts) und den nächtlichen Worker-Job
// (apps/worker/src/jobs/backup-run.ts). Beide unterscheiden sich nur im Sink:
// der Betreiber-Lauf legt zuerst eine private lokale Kopie an (Air-Gap), der
// Worker (read-only, 64-MB-tmpfs) streamt direkt in den Object-Store.
// Object-Store-Upload und Audit-Service injiziert der Aufrufer.
// ---------------------------------------------------------------------------

/** Ab diesem Alter gilt ein RUNNING-BackupRecord als verwaist (SIGKILL/OOM/Stromausfall). */
export const BACKUP_STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Objekt-Key eines Dumps. Sekunden + Zufallssuffix: Betreiber-Lauf und
 * Worker-Job laufen prozessübergreifend; bei Minutengranularität könnten zwei
 * parallele Läufe denselben Key überschreiben (ein Dump ginge verloren,
 * während beide Records SUCCESS meldeten).
 */
export function backupObjectKey(
  now: Date,
  suffix: string = randomBytes(3).toString('hex'),
): string {
  const date = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  const time = `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  return `pgdump/${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}/taxtronik-${date}-${time}-${suffix}.sql.gz`;
}

export interface BackupRecordRef {
  id: string;
  tenantId: string;
}

/** Owner-Client des Aufrufers (BYPASSRLS): Tenants, BackupRecords und Audit-Transaktionen. */
export interface PgBackupDb {
  tenant: { findMany(args: { select: { id: true } }): Promise<Array<{ id: string }>> };
  backupRecord: {
    create(args: { data: { tenantId: string; status: 'RUNNING' } }): Promise<BackupRecordRef>;
    updateMany(args: {
      where: Prisma.BackupRecordWhereInput;
      data: Prisma.BackupRecordUpdateManyMutationInput;
    }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/** `backup.run` gehört als Systemereignis in die Audit-Hash-Chain (RF-12), Erfolg wie Fehlschlag. */
export interface BackupRunAuditEntry {
  tenantId: string;
  actorType: 'SYSTEM';
  actorId: null;
  action: 'backup.run';
  resourceType: 'backup_record';
  resourceId: string;
  after: Record<string, unknown>;
}

export type BackupAuditRecorder = (
  tx: Prisma.TransactionClient,
  entry: BackupRunAuditEntry,
) => Promise<unknown>;

export interface PgBackupStored extends PgDumpResult {
  /** Nur Betreiber-Lauf: Pfad der lokalen Operator-Kopie. */
  localPath?: string;
}

export interface PgBackupSink {
  /** Vor dem Start von pg_dump, z. B. lokalen Zielpfad anlegen; wirft mit fertiger Meldung. */
  prepare?(key: string): Promise<void>;
  /** Überträgt den Dump vollständig; wirft mit fertiger Meldung und räumt selbst auf. */
  store(dump: PgDumpProcess, key: string): Promise<PgBackupStored>;
}

/** Object-Store-Zugriff des Aufrufers (Multipart-Upload per @aws-sdk/lib-storage). */
export interface BackupObjectStore {
  upload(body: Readable, key: string): Promise<void>;
  /** Löscht ein (evtl. unvollständiges) Objekt; Fehler behandelt der Sink. */
  remove(key: string): Promise<void>;
}

/** Worker: pg_dump-stdout ohne lokale Kopie direkt als Multipart-Upload. */
export function streamingBackupSink(objects: BackupObjectStore): PgBackupSink {
  return {
    async store(dump, key) {
      try {
        await objects.upload(dump.stream, key);
        return await dump.result();
      } catch (e) {
        // pg_dump beenden, falls er noch läuft (z. B. Upload-Init-Fehler): sonst
        // hält er eine DB-Verbindung; das verwaiste Objekt best-effort entfernen.
        dump.abort();
        try {
          await objects.remove(key);
        } catch {
          // best effort: das Ergebnis meldet bereits den Fehlschlag
        }
        throw new Error(`Backup fehlgeschlagen: ${(e as Error).message}`, { cause: e });
      }
    },
  };
}

/**
 * Betreiber-Lauf: zuerst eine private lokale Kopie (Mode 0600 — der Dump
 * enthält Passwort-Hashes), danach Upload aus dieser Datei. Die lokale Kopie
 * bleibt auch bei einem Upload-Fehler erhalten.
 */
export function localCopyBackupSink(
  objects: BackupObjectStore,
  options: {
    /** Legt den Zielordner an und liefert den Dateipfad zum Key. */
    localPathFor(key: string): Promise<string>;
    onCleanupError?(key: string, err: Error): void;
  },
): PgBackupSink {
  let localPath = '';
  return {
    async prepare(key) {
      try {
        localPath = await options.localPathFor(key);
      } catch (e) {
        throw new Error(`Lokaler Backup-Pfad nicht bereit: ${(e as Error).message}`, { cause: e });
      }
    },
    async store(dump, key) {
      try {
        await pipeline(dump.stream, createWriteStream(localPath, { mode: 0o600 }));
      } catch (e) {
        dump.abort();
        await dump.result().catch(() => undefined);
        await unlink(localPath).catch(() => undefined);
        throw new Error(`Lokaler Backup-Write fehlgeschlagen: ${(e as Error).message}`, {
          cause: e,
        });
      }
      let result: PgDumpResult;
      try {
        result = await dump.result();
      } catch (e) {
        await unlink(localPath).catch(() => undefined);
        throw e;
      }
      let body: Readable | undefined;
      try {
        // Datei vor dem Upload öffnen: Bricht der Upload früh ab, schließt
        // destroy() den Handle deterministisch statt eines noch offenen open().
        body = (await open(localPath, 'r')).createReadStream();
        await objects.upload(body, key);
      } catch (e) {
        body?.destroy();
        try {
          await objects.remove(key);
        } catch (removeError) {
          options.onCleanupError?.(key, removeError as Error);
        }
        throw new Error(`S3-Upload fehlgeschlagen: ${(e as Error).message}`, { cause: e });
      }
      return { ...result, localPath };
    },
  };
}

export interface PgBackupRunOptions {
  db: PgBackupDb;
  recordAudit: BackupAuditRecorder;
  sink: PgBackupSink;
  databaseUrl: string | undefined;
  bucket: string;
  now?: Date;
  /** Worker: ohne Tenant gibt es nichts zu sichern. Der Betreiber-Lauf sichert trotzdem. */
  skipWithoutTenants?: boolean;
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Nur für Tests: pg_dump-Prozess ersetzen. */
  spawnDump?: (connectionEnv: Record<string, string>, args: readonly string[]) => PgDumpProcess;
}

export interface PgBackupRunResult {
  ok: boolean;
  error?: string;
  recordId?: string;
  key?: string;
  bucket?: string;
  sizeBytes?: number;
  sha256?: string;
  localPath?: string;
}

async function markBackupRecords(
  options: PgBackupRunOptions,
  records: readonly BackupRecordRef[],
  data: Prisma.BackupRecordUpdateInput,
  after: Record<string, unknown>,
): Promise<void> {
  await Promise.all(
    records.map((record) =>
      options.db.$transaction(async (tx) => {
        await tx.backupRecord.update({ where: { id: record.id }, data });
        await options.recordAudit(tx, {
          tenantId: record.tenantId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'backup.run',
          resourceType: 'backup_record',
          resourceId: record.id,
          after,
        });
      }),
    ),
  );
}

/**
 * Ein vollständiger Backup-Lauf: verwaiste RUNNING-Records abschließen, je
 * Tenant einen RUNNING-Record anlegen, pg_dump über den Sink sichern und jeden
 * Record samt `backup.run`-Audit-Event auf SUCCESS bzw. FAILED setzen.
 */
export async function runPgBackup(options: PgBackupRunOptions): Promise<PgBackupRunResult> {
  const { db, bucket } = options;
  const now = options.now ?? new Date();
  const tenants = await db.tenant.findMany({ select: { id: true } });
  if (tenants.length === 0 && options.skipWithoutTenants) return { ok: true };

  // Zombie-Reconcile: nach SIGKILL/OOM/Stromausfall mitten im Dump bliebe ein
  // Record sonst dauerhaft RUNNING (Admin-UI zeigt ein ewig laufendes Backup).
  const reconciled = await db.backupRecord.updateMany({
    where: {
      status: 'RUNNING',
      startedAt: { lt: new Date(now.getTime() - BACKUP_STALE_RUNNING_MS) },
    },
    data: {
      status: 'FAILED',
      finishedAt: now,
      errorMsg: 'Abgebrochen (verwaister RUNNING-Record, vermutlich Prozess-Crash).',
    },
  });
  if (reconciled.count > 0) {
    options.log?.warn(
      { count: reconciled.count },
      'backup: verwaiste RUNNING-Records auf FAILED gesetzt',
    );
  }

  const records = await Promise.all(
    tenants.map((tenant) =>
      db.backupRecord.create({ data: { tenantId: tenant.id, status: 'RUNNING' } }),
    ),
  );
  const fail = async (error: string): Promise<PgBackupRunResult> => {
    await markBackupRecords(
      options,
      records,
      { status: 'FAILED', finishedAt: new Date(), errorMsg: error },
      { status: 'FAILED', error },
    );
    return { ok: false, error };
  };

  if (!options.databaseUrl) return fail('DATABASE_URL nicht gesetzt');
  let connection: PgConnectionArgs;
  try {
    connection = pgConnArgs(options.databaseUrl);
  } catch (e) {
    return fail(`DATABASE_URL nicht parsebar: ${(e as Error).message}`);
  }

  const key = backupObjectKey(now);
  try {
    await options.sink.prepare?.(key);
  } catch (e) {
    return fail((e as Error).message);
  }

  // ACLs gehören zum sicherheitsrelevanten Datenbankzustand (REVOKEs auf
  // Audit-Tabellen, SECURITY-DEFINER-Funktionen, Grants an taxtronik_app):
  // pgDumpArgs macht nur die Ownership portabel.
  const dump = (options.spawnDump ?? spawnPgDump)(connection.env, pgDumpArgs(connection.args));
  let stored: PgBackupStored;
  try {
    stored = await options.sink.store(dump, key);
  } catch (e) {
    return fail((e as Error).message);
  }

  const sha256 = stored.sha.toString('hex');
  const localPath = stored.localPath ? { localPath: stored.localPath } : {};
  await markBackupRecords(
    options,
    records,
    {
      status: 'SUCCESS',
      finishedAt: new Date(),
      sizeBytes: BigInt(stored.sizeBytes),
      bucket,
      key,
      sha256: prismaBytes(stored.sha),
    },
    { status: 'SUCCESS', sizeBytes: stored.sizeBytes, bucket, key, ...localPath, sha256 },
  );
  return {
    ok: true,
    recordId: records[0]?.id,
    key,
    bucket,
    sizeBytes: stored.sizeBytes,
    sha256,
    ...localPath,
  };
}
