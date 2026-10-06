import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backupObjectKey,
  localCopyBackupSink,
  pgConnArgs,
  pgDumpArgs,
  pgRestoreArgs,
  runPgBackup,
  spawnPgDump,
  streamingBackupSink,
  type BackupRunAuditEntry,
  type PgBackupDb,
} from '../pg-tools';

describe('PostgreSQL process tools', () => {
  it('keeps credentials out of argv and preserves SSL mode', () => {
    const result = pgConnArgs(
      'postgresql://db%20user:s3cr%25t@db.internal:6543/taxtronik?sslmode=require',
    );

    expect(result.args).toEqual([
      '-h',
      'db.internal',
      '-p',
      '6543',
      '-U',
      'db user',
      '-d',
      'taxtronik',
    ]);
    expect(result.args.join(' ')).not.toContain('s3cr');
    expect(result.env).toEqual({ PGPASSWORD: 's3cr%t', PGSSLMODE: 'require' });
  });

  it('builds one canonical custom-format dump argument list', () => {
    expect(pgDumpArgs(['-h', 'db'])).toEqual([
      '--format=custom',
      '--no-owner',
      '--compress=6',
      '-h',
      'db',
    ]);
  });

  it('streams bytes while calculating their hash and size', async () => {
    const content = 'shared dump stream';
    const dump = spawnPgDump({}, ['-e', `process.stdout.write(${JSON.stringify(content)})`], {
      path: process.execPath,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of dump.stream) chunks.push(Buffer.from(chunk));

    await expect(dump.result()).resolves.toEqual({
      sha: createHash('sha256').update(content).digest(),
      sizeBytes: Buffer.byteLength(content),
    });
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
  });

  it('reports missing pg_dump executables without an unhandled stream error', async () => {
    const dump = spawnPgDump({}, [], { path: 'definitely-missing-pg-dump-binary' });
    dump.stream.on('error', () => undefined);
    await expect(dump.result()).rejects.toThrow('pg_dump konnte nicht gestartet werden');
  });
});

// R-02: Produktiv-Restore und Restore-Drill teilen eine Flag-Liste.
describe('pgRestoreArgs', () => {
  it('builds the one restore argument list of production restore and drill', () => {
    expect(pgRestoreArgs(['-h', 'db', '-d', 'taxtronik_drill'], '/backups/dump.sql.gz')).toEqual([
      '--clean',
      '--if-exists',
      '--no-owner',
      '--single-transaction',
      '--exit-on-error',
      '-h',
      'db',
      '-d',
      'taxtronik_drill',
      '/backups/dump.sql.gz',
    ]);
  });
});

// R-02: ein Backup-Runner für Betreiber-Lauf (lokale Kopie) und Worker (Stream).
describe('runPgBackup', () => {
  const NOW = new Date('2026-07-07T01:02:03.000Z');
  const DUMP = 'synthetic dump bytes';
  const DB_URL = 'postgresql://taxtronik:pw@db.internal:5432/taxtronik';

  function fakeDump(script = `process.stdout.write(${JSON.stringify(DUMP)})`) {
    return () => spawnPgDump({}, ['-e', script], { path: process.execPath });
  }

  async function drain(body: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  function fakeDb(tenantIds: string[] = ['t-1', 't-2']) {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const audits: BackupRunAuditEntry[] = [];
    const db = {
      tenant: { findMany: vi.fn(async () => tenantIds.map((id) => ({ id }))) },
      backupRecord: {
        create: vi.fn(async ({ data }: { data: { tenantId: string } }) => ({
          id: `rec-${data.tenantId}`,
          tenantId: data.tenantId,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          backupRecord: {
            update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) =>
              updates.push({ id: args.where.id, data: args.data }),
            ),
          },
        }),
      ),
    };
    const recordAudit = vi.fn(async (_tx: unknown, entry: BackupRunAuditEntry) => {
      audits.push(entry);
    });
    return { db: db as unknown as PgBackupDb, raw: db, updates, audits, recordAudit };
  }

  it('builds unique second-precision object keys', () => {
    expect(backupObjectKey(NOW, 'abc123')).toBe(
      'pgdump/2026/07/07/taxtronik-20260707-010203-abc123.sql.gz',
    );
    expect(backupObjectKey(NOW)).toMatch(
      /^pgdump\/2026\/07\/07\/taxtronik-20260707-010203-[0-9a-f]{6}\.sql\.gz$/,
    );
  });

  it('streams the dump, marks every record SUCCESS and audits backup.run in the same tx', async () => {
    const { db, raw, updates, audits, recordAudit } = fakeDb();
    const uploaded: string[] = [];
    const result = await runPgBackup({
      db,
      recordAudit,
      sink: streamingBackupSink({
        upload: async (body, key) => {
          uploaded.push(`${key}:${await drain(body)}`);
        },
        remove: vi.fn(),
      }),
      databaseUrl: DB_URL,
      bucket: 'backups',
      now: NOW,
      spawnDump: fakeDump(),
    });

    const sha256 = createHash('sha256').update(DUMP).digest('hex');
    expect(result).toEqual({
      ok: true,
      recordId: 'rec-t-1',
      key: expect.stringMatching(/^pgdump\/2026\/07\/07\/taxtronik-20260707-010203-/),
      bucket: 'backups',
      sizeBytes: Buffer.byteLength(DUMP),
      sha256,
    });
    expect(uploaded).toEqual([`${result.key}:${DUMP}`]);
    expect(raw.backupRecord.create.mock.calls.map(([args]) => args)).toEqual([
      { data: { tenantId: 't-1', status: 'RUNNING' } },
      { data: { tenantId: 't-2', status: 'RUNNING' } },
    ]);
    expect(updates.map((update) => update.data.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(updates[0]!.data).toMatchObject({
      sizeBytes: BigInt(Buffer.byteLength(DUMP)),
      bucket: 'backups',
      key: result.key,
    });
    expect(audits).toEqual([
      expect.objectContaining({
        tenantId: 't-1',
        actorType: 'SYSTEM',
        actorId: null,
        action: 'backup.run',
        resourceType: 'backup_record',
        resourceId: 'rec-t-1',
        after: { status: 'SUCCESS', sizeBytes: 20, bucket: 'backups', key: result.key, sha256 },
      }),
      expect.objectContaining({ resourceId: 'rec-t-2' }),
    ]);
  });

  it('closes orphaned RUNNING records older than six hours before every run', async () => {
    const { db, raw, recordAudit } = fakeDb();
    const log = { warn: vi.fn() };
    await runPgBackup({
      db,
      recordAudit,
      sink: streamingBackupSink({
        upload: async (body) => void (await drain(body)),
        remove: vi.fn(),
      }),
      databaseUrl: DB_URL,
      bucket: 'backups',
      now: NOW,
      log,
      spawnDump: fakeDump(),
    });

    expect(raw.backupRecord.updateMany).toHaveBeenCalledWith({
      where: { status: 'RUNNING', startedAt: { lt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000) } },
      data: {
        status: 'FAILED',
        finishedAt: NOW,
        errorMsg: 'Abgebrochen (verwaister RUNNING-Record, vermutlich Prozess-Crash).',
      },
    });
    expect(log.warn).toHaveBeenCalledWith({ count: 1 }, expect.stringContaining('RUNNING'));
  });

  it('marks records FAILED, aborts pg_dump and removes the partial object on a failed upload', async () => {
    const { db, updates, audits, recordAudit } = fakeDb(['t-1']);
    const remove = vi.fn(async () => undefined);
    const result = await runPgBackup({
      db,
      recordAudit,
      sink: streamingBackupSink({
        upload: async () => {
          throw new Error('multipart init refused');
        },
        remove,
      }),
      databaseUrl: DB_URL,
      bucket: 'backups',
      now: NOW,
      // Würde ohne Abbruch endlos schreiben.
      spawnDump: fakeDump('setInterval(() => process.stdout.write("x"), 5)'),
    });

    expect(result).toEqual({ ok: false, error: 'Backup fehlgeschlagen: multipart init refused' });
    expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^pgdump\//));
    expect(updates[0]!.data).toMatchObject({
      status: 'FAILED',
      errorMsg: 'Backup fehlgeschlagen: multipart init refused',
    });
    expect(audits[0]).toMatchObject({
      action: 'backup.run',
      after: { status: 'FAILED', error: 'Backup fehlgeschlagen: multipart init refused' },
    });
  });

  it('reports a failing pg_dump with its exit code', async () => {
    const { db, recordAudit } = fakeDb(['t-1']);
    const result = await runPgBackup({
      db,
      recordAudit,
      sink: streamingBackupSink({
        upload: async (body) => void (await drain(body)),
        remove: vi.fn(),
      }),
      databaseUrl: DB_URL,
      bucket: 'backups',
      now: NOW,
      spawnDump: fakeDump('process.stderr.write("boom"); process.exit(3)'),
    });
    expect(result).toEqual({ ok: false, error: 'Backup fehlgeschlagen: pg_dump exit 3: boom' });
  });

  it('fails every record without a usable DATABASE_URL and never starts pg_dump', async () => {
    for (const databaseUrl of [undefined, 'mysql://nope']) {
      const { db, updates, recordAudit } = fakeDb(['t-1']);
      const spawnDump = vi.fn();
      const result = await runPgBackup({
        db,
        recordAudit,
        sink: streamingBackupSink({ upload: vi.fn(), remove: vi.fn() }),
        databaseUrl,
        bucket: 'backups',
        now: NOW,
        spawnDump,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(
        /^DATABASE_URL nicht (gesetzt|parsebar: PostgreSQL-URL erwartet\.)$/,
      );
      expect(updates[0]!.data).toMatchObject({ status: 'FAILED', errorMsg: result.error });
      expect(spawnDump).not.toHaveBeenCalled();
    }
  });

  it('skips a tenantless installation only when the caller asks for it', async () => {
    const skipped = fakeDb([]);
    const spawnDump = vi.fn();
    await expect(
      runPgBackup({
        db: skipped.db,
        recordAudit: skipped.recordAudit,
        sink: streamingBackupSink({ upload: vi.fn(), remove: vi.fn() }),
        databaseUrl: DB_URL,
        bucket: 'backups',
        skipWithoutTenants: true,
        spawnDump,
      }),
    ).resolves.toEqual({ ok: true });
    expect(skipped.raw.backupRecord.updateMany).not.toHaveBeenCalled();
    expect(spawnDump).not.toHaveBeenCalled();

    const dumped = fakeDb([]);
    const result = await runPgBackup({
      db: dumped.db,
      recordAudit: dumped.recordAudit,
      sink: streamingBackupSink({
        upload: async (body) => void (await drain(body)),
        remove: vi.fn(),
      }),
      databaseUrl: DB_URL,
      bucket: 'backups',
      spawnDump: fakeDump(),
    });
    expect(result).toMatchObject({ ok: true, sizeBytes: Buffer.byteLength(DUMP) });
    expect(dumped.raw.backupRecord.create).not.toHaveBeenCalled();
  });

  describe('localCopyBackupSink (Betreiber-Lauf)', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tt-backup-sink-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('writes a private local copy first, uploads it and reports its path', async () => {
      const { db, audits, recordAudit } = fakeDb(['t-1']);
      const uploaded: string[] = [];
      const result = await runPgBackup({
        db,
        recordAudit,
        sink: localCopyBackupSink(
          { upload: async (body) => void uploaded.push(await drain(body)), remove: vi.fn() },
          { localPathFor: async () => join(dir, 'dump.sql.gz') },
        ),
        databaseUrl: DB_URL,
        bucket: 'backups',
        now: NOW,
        spawnDump: fakeDump(),
      });

      const localPath = join(dir, 'dump.sql.gz');
      expect(result).toMatchObject({ ok: true, localPath });
      expect(readFileSync(localPath, 'utf8')).toBe(DUMP);
      expect(statSync(localPath).mode & 0o777).toBe(0o600);
      expect(uploaded).toEqual([DUMP]);
      expect(audits[0]).toMatchObject({ after: { status: 'SUCCESS', localPath } });
    });

    it('keeps the local copy but removes the partial object when the upload fails', async () => {
      const { db, recordAudit } = fakeDb(['t-1']);
      const onCleanupError = vi.fn();
      const removeError = new Error('delete denied');
      const result = await runPgBackup({
        db,
        recordAudit,
        sink: localCopyBackupSink(
          {
            upload: async () => {
              throw new Error('S3 down');
            },
            remove: async () => {
              throw removeError;
            },
          },
          { localPathFor: async () => join(dir, 'dump.sql.gz'), onCleanupError },
        ),
        databaseUrl: DB_URL,
        bucket: 'backups',
        now: NOW,
        spawnDump: fakeDump(),
      });

      expect(result).toEqual({ ok: false, error: 'S3-Upload fehlgeschlagen: S3 down' });
      expect(existsSync(join(dir, 'dump.sql.gz'))).toBe(true);
      expect(onCleanupError).toHaveBeenCalledWith(expect.stringMatching(/^pgdump\//), removeError);
    });

    it('removes an incomplete local copy when pg_dump fails', async () => {
      const { db, recordAudit } = fakeDb(['t-1']);
      const result = await runPgBackup({
        db,
        recordAudit,
        sink: localCopyBackupSink(
          { upload: vi.fn(), remove: vi.fn() },
          { localPathFor: async () => join(dir, 'dump.sql.gz') },
        ),
        databaseUrl: DB_URL,
        bucket: 'backups',
        now: NOW,
        spawnDump: fakeDump('process.stdout.write("half"); process.exit(1)'),
      });

      expect(result).toEqual({ ok: false, error: 'pg_dump exit 1: ' });
      expect(existsSync(join(dir, 'dump.sql.gz'))).toBe(false);
    });

    it('fails before starting pg_dump when the local target is not ready', async () => {
      const { db, recordAudit } = fakeDb(['t-1']);
      const spawnDump = vi.fn();
      const result = await runPgBackup({
        db,
        recordAudit,
        sink: localCopyBackupSink(
          { upload: vi.fn(), remove: vi.fn() },
          {
            localPathFor: async () => {
              throw new Error('BACKUP_LOCAL_DIR fehlt');
            },
          },
        ),
        databaseUrl: DB_URL,
        bucket: 'backups',
        now: NOW,
        spawnDump,
      });

      expect(result).toEqual({
        ok: false,
        error: 'Lokaler Backup-Pfad nicht bereit: BACKUP_LOCAL_DIR fehlt',
      });
      expect(spawnDump).not.toHaveBeenCalled();
    });
  });
});
