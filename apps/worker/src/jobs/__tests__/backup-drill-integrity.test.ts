// Fachkatalog: BACKUP-DRILL-INTEGRITY-001
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgRestoreArgs } from '@taxtronik/db/pg-tools';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  spawn: vi.fn(),
  ddl: vi.fn(),
  backup: vi.fn(),
  verify: vi.fn(),
  record: vi.fn(),
  disconnect: vi.fn(),
  adminDisconnect: vi.fn(),
  clientUrls: [] as string[],
  env: { DATABASE_URL: '', NODE_ENV: 'development' },
}));
vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = h.send;
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));
vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    tenant: { findMany: async () => [{ id: 'tenant-1', createdAt: new Date('2020-01-01') }] },
    backupRecord: { findFirst: h.backup },
    staffUser: { findMany: async () => [] },
    // S-01: Die Owner-Verbindung darf keine Datenbanken anlegen.
    $executeRawUnsafe: () => {
      throw new Error('owner connection must not run drill DDL');
    },
  },
}));
vi.mock('@taxtronik/db/prisma-client', () => ({
  PrismaClient: class {
    tenant = { findUnique: async () => ({ id: 'tenant-1' }) };
    $transaction = async (callback: (tx: object) => unknown) => callback({});
    $executeRawUnsafe = h.ddl;
    $disconnect: () => Promise<void>;
    constructor({ adapter }: { adapter: { url: string } }) {
      h.clientUrls.push(adapter.url);
      // Wegwerf-DB (Prüfung) vs. Wartungsverbindung für CREATE/DROP DATABASE.
      this.$disconnect = new URL(adapter.url).pathname.startsWith('/taxtronik_drill_')
        ? h.disconnect
        : h.adminDisconnect;
    }
  },
}));
vi.mock('@taxtronik/db/prisma-adapter', () => ({
  createPostgresAdapter: (url: string) => ({ url }),
}));
vi.mock('@taxtronik/db/tenant-settings', () => ({ writeTenantSettingValue: vi.fn() }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    verifyChain = h.verify;
    record = h.record;
  },
  LocalTimestampAdapter: class {},
  BACKUP_DRILL_RESULT_SETTING_KEY: 'backup_drill_result',
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: async (_tenant: string, fn: (tx: object) => unknown) => fn({}),
}));
vi.mock('../../notify', () => ({ notify: vi.fn() }));
vi.mock('../../tsa-port', () => ({ timestampPortFor: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { processors } from './mocks/bullmq';
import { drillRestoreList } from '../backup-drill';

const OWNER_URL =
  'postgresql://taxtronik_owner:owner-password@postgres:5432/taxtronik?schema=public';
const DRILL_URL =
  'postgresql://taxtronik_drill:drill-password@postgres:5432/postgres?schema=public';
const TOC = [
  ';',
  '; Archive created at 2026-10-06 18:44:17 CEST',
  '3201; 2615 2200 SCHEMA - app taxtronik',
  '3202; 826 614572 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES taxtronik',
  '3203; 826 614573 DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES taxtronik',
  '3204; 0 0 ACL public TABLE audit_log taxtronik',
].join('\n');

/** pg_restore-Attrappe: --list liefert die TOC, jeder Restore endet mit `exit`. */
function fakePgRestore(args: string[], exit = 0) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  queueMicrotask(() => {
    if (args[0] === '--list') child.stdout.emit('data', Buffer.from(TOC));
    child.emit('close', args[0] === '--list' ? 0 : exit);
  });
  return child;
}

describe('BACKUP-DRILL-INTEGRITY-001: real job rejects altered S3 bytes before pg_restore', () => {
  const original = Buffer.from('trusted original dump');
  let directory: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    h.clientUrls.length = 0;
    h.env.DATABASE_URL = OWNER_URL;
    h.env.NODE_ENV = 'development';
    directory = await mkdtemp(join(tmpdir(), 'drill-job-test-'));
    vi.stubEnv('BACKUP_DRILL_TMP_DIR', directory);
    vi.stubEnv('DATABASE_DRILL_URL', DRILL_URL);
    h.backup.mockResolvedValue({
      key: 'backup.dump',
      bucket: 'backups',
      finishedAt: new Date(),
      sha256: createHash('sha256').update(original).digest(),
      sizeBytes: BigInt(original.length),
    });
    h.send.mockImplementation(async () => ({ Body: Readable.from([original]) }));
    h.verify.mockResolvedValue({ ok: true, checked: 2 });
    h.ddl.mockResolvedValue(0);
    h.disconnect.mockResolvedValue(undefined);
    h.adminDisconnect.mockResolvedValue(undefined);
    h.record.mockResolvedValue(undefined);
    h.spawn.mockImplementation((_program: string, args: string[]) => fakePgRestore(args));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('checks the DB digest before any restore process or scratch database is created', async () => {
    const changed = Buffer.from(original);
    changed[0] = changed[0]! ^ 1;
    h.send.mockResolvedValue({ Body: Readable.from([changed]) });
    const result = await processors.get('backup-drill')!({ data: {} });
    expect(result).toMatchObject({ ok: false });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.ddl.mock.calls.some(([sql]) => String(sql).startsWith('CREATE DATABASE'))).toBe(false);
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'backup.drill.failed' }),
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it('hands pg_restore the same verified local bytes, only then verifies and cleans the scratch database', async () => {
    let restoredPath = '';
    let restoredBytes: Buffer | undefined;
    let restoreList = '';
    h.spawn.mockImplementation((_program: string, args: string[]) => {
      if (args[0] === '--list') return fakePgRestore(args);
      restoredPath = args.at(-1)!;
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
      void Promise.all([
        readFile(restoredPath),
        readFile(args[0]!.slice('--use-list='.length), 'utf8'),
      ])
        .then(([bytes, list]) => {
          restoredBytes = bytes;
          restoreList = list;
          child.emit('close', 0);
        })
        .catch((error: unknown) => child.emit('error', error));
      return child;
    });
    const result = await processors.get('backup-drill')!({ data: {} });
    expect(result).toMatchObject({ ok: true });
    expect(restoredBytes).toEqual(original);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    // Die TOC stammt aus derselben geprüften Datei; nur Default-ACLs der
    // Migrationsrolle entfallen, GRANT/REVOKE bleiben Teil des Drills.
    expect(h.spawn.mock.calls[0]![1]).toEqual(['--list', restoredPath]);
    expect(restoreList).toBe(drillRestoreList(TOC));
    expect(restoreList).not.toContain('DEFAULT ACL');
    expect(restoreList).toContain('ACL public TABLE audit_log taxtronik');
    // R-02: exakt die Flag-Liste des Produktiv-Restores (pgRestoreArgs, @taxtronik/db/pg-tools).
    const restoreArgs = h.spawn.mock.calls[1]![1] as string[];
    expect(restoreArgs[0]).toBe(`--use-list=${restoredPath}.list`);
    expect(restoreArgs.slice(1, 6)).toEqual([
      '--clean',
      '--if-exists',
      '--no-owner',
      '--single-transaction',
      '--exit-on-error',
    ]);
    const connection = restoreArgs.slice(6, -1);
    expect(restoreArgs.slice(1)).toEqual(pgRestoreArgs(connection, restoredPath));
    // S-01: Restore, Prüfung und CREATE/DROP DATABASE laufen unter der Drill-Rolle.
    expect(connection.slice(0, 6)).toEqual([
      '-h',
      'postgres',
      '-p',
      '5432',
      '-U',
      'taxtronik_drill',
    ]);
    expect(connection[7]).toMatch(/^taxtronik_drill_[0-9a-f]{24}$/);
    expect(h.spawn.mock.calls[1]![2]).toMatchObject({ env: { PGPASSWORD: 'drill-password' } });
    expect(h.clientUrls.length).toBeGreaterThan(0);
    for (const url of h.clientUrls) expect(new URL(url).username).toBe('taxtronik_drill');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.ddl.mock.calls[0]?.[0]).toMatch(/^CREATE DATABASE taxtronik_drill_[0-9a-f]{24}$/);
    expect(h.ddl.mock.calls.at(-1)?.[0]).toContain('DROP DATABASE IF EXISTS taxtronik_drill_');
    expect(restoredPath.startsWith(directory)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['restore-audit', 'success-audit', 'disconnect'])(
    'drops the scratch database despite %s failure',
    async (stage) => {
      if (stage === 'restore-audit') {
        h.spawn.mockImplementationOnce(() => {
          const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
          queueMicrotask(() => child.emit('close', 1));
          return child;
        });
      }
      if (stage === 'disconnect')
        h.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
      else h.record.mockRejectedValueOnce(new Error('audit failed'));

      await expect(processors.get('backup-drill')!({ data: {} })).rejects.toThrow(
        /audit failed|disconnect failed/,
      );
      const create = h.ddl.mock.calls.find(([sql]) =>
        String(sql).startsWith('CREATE DATABASE'),
      )?.[0] as string;
      expect(create).toMatch(/^CREATE DATABASE taxtronik_drill_[0-9a-f]{24}$/);
      expect(h.ddl).toHaveBeenLastCalledWith(
        `DROP DATABASE IF EXISTS ${create.slice('CREATE DATABASE '.length)} WITH (FORCE)`,
      );
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('S-01: fails closed in production without the drill role and never runs drill DDL', async () => {
    vi.stubEnv('DATABASE_DRILL_URL', '');
    h.env.NODE_ENV = 'production';
    await expect(processors.get('backup-drill')!({ data: {} })).resolves.toMatchObject({
      ok: false,
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.ddl).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'backup.drill.failed',
        after: expect.objectContaining({
          error: expect.stringContaining('DATABASE_DRILL_URL fehlt'),
        }),
      }),
    );
  });

  it('reports a missing S3 response body without creating a scratch database', async () => {
    h.send.mockResolvedValueOnce({});
    await expect(processors.get('backup-drill')!({ data: {} })).resolves.toMatchObject({
      ok: false,
    });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({
          error: expect.stringContaining('keinen lesbaren Dump-Body'),
        }),
      }),
    );
  });
});
