// Fachkatalog: BACKUP-DRILL-INTEGRITY-001
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  spawn: vi.fn(),
  ddl: vi.fn(),
  backup: vi.fn(),
  verify: vi.fn(),
  record: vi.fn(),
  disconnect: vi.fn(),
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
vi.mock('@taxtronik/config', () => ({
  env: {
    DATABASE_URL: 'postgresql://owner:password@postgres:5432/production',
    NODE_ENV: 'development',
  },
}));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    tenant: { findMany: async () => [{ id: 'tenant-1', createdAt: new Date('2020-01-01') }] },
    backupRecord: { findFirst: h.backup },
    staffUser: { findMany: async () => [] },
    $executeRawUnsafe: h.ddl,
  },
}));
vi.mock('@taxtronik/db/prisma-client', () => ({
  PrismaClient: class {
    tenant = { findUnique: async () => ({ id: 'tenant-1' }) };
    $transaction = async (callback: (tx: object) => unknown) => callback({});
    $disconnect = h.disconnect;
  },
}));
vi.mock('@taxtronik/db/prisma-adapter', () => ({ createPostgresAdapter: () => ({}) }));
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
import '../backup-drill';

describe('BACKUP-DRILL-INTEGRITY-001: real job rejects altered S3 bytes before pg_restore', () => {
  const original = Buffer.from('trusted original dump');
  let directory: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'drill-job-test-'));
    vi.stubEnv('BACKUP_DRILL_TMP_DIR', directory);
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
    h.record.mockResolvedValue(undefined);
    h.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
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
    h.spawn.mockImplementation((_program: string, args: string[]) => {
      restoredPath = args.at(-1)!;
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
      void readFile(restoredPath)
        .then((bytes) => {
          restoredBytes = bytes;
          child.emit('close', 0);
        })
        .catch((error: unknown) => child.emit('error', error));
      return child;
    });
    const result = await processors.get('backup-drill')!({ data: {} });
    expect(result).toMatchObject({ ok: true });
    expect(restoredBytes).toEqual(original);
    expect(h.spawn).toHaveBeenCalledTimes(1);
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
