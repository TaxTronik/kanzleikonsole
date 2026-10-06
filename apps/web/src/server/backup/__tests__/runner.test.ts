// =============================================================================
// R-02: Der Betreiber-Lauf (`pnpm backup:run`, `./taxtronik backup`) nutzt
// denselben Runner wie der nächtliche Worker-Job (runPgBackup aus
// @taxtronik/db/pg-tools): lokale Operator-Kopie (0600) vor dem Upload,
// backup.run-Audit je Record und — neu für diesen Pfad — Abschluss verwaister
// RUNNING-Records.
// =============================================================================

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const txUpdate = vi.fn();
  return {
    txUpdate,
    prismaOwner: {
      tenant: { findMany: vi.fn() },
      backupRecord: { create: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ backupRecord: { update: txUpdate } }),
      ),
    },
    record: vi.fn(),
    uploads: [] as Array<{ key: string; body: string }>,
    s3Send: vi.fn(),
  };
});

vi.mock('@taxtronik/config', () => ({
  env: { S3_ENDPOINT: 'http://s3', S3_REGION: 'us-east-1', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 's' },
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = h.s3Send;
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(private opts: { params: { Key: string; Body: Readable } }) {}
    async done() {
      const chunks: Buffer[] = [];
      for await (const chunk of this.opts.params.Body) chunks.push(Buffer.from(chunk));
      h.uploads.push({ key: this.opts.params.Key, body: Buffer.concat(chunks).toString('utf8') });
    }
  },
}));
// Fake pg_dump: schreibt einen festen Dump und endet mit Exit 0.
vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: null;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => undefined;
    setImmediate(() => {
      child.stdout.end(Buffer.from('DUMPBYTES'));
      child.exitCode = 0;
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  },
}));

import { runBackup } from '../runner';

let backupDir = '';

beforeEach(() => {
  vi.clearAllMocks();
  h.uploads.length = 0;
  backupDir = mkdtempSync(join(tmpdir(), 'tt-web-backup-'));
  vi.stubEnv('BACKUP_LOCAL_DIR', backupDir);
  vi.stubEnv('DATABASE_URL', 'postgresql://taxtronik:pw@db.internal:5432/taxtronik');
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 'tenant-1' }]);
  h.prismaOwner.backupRecord.create.mockImplementation(async ({ data }) => ({
    id: `rec-${data.tenantId}`,
    tenantId: data.tenantId,
  }));
  h.prismaOwner.backupRecord.updateMany.mockResolvedValue({ count: 0 });
  h.record.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(backupDir, { recursive: true, force: true });
});

describe('runBackup (Betreiber-Lauf)', () => {
  it('legt die lokale Kopie an, lädt sie hoch und auditiert den Lauf', async () => {
    const result = await runBackup();

    expect(result).toMatchObject({ ok: true, recordId: 'rec-tenant-1', sizeBytes: 9 });
    expect(result.localPath).toMatch(
      new RegExp(`^${backupDir}/taxtronik-\\d{8}-\\d{6}-[0-9a-f]{6}\\.sql\\.gz$`),
    );
    expect(readFileSync(result.localPath!, 'utf8')).toBe('DUMPBYTES');
    expect(h.uploads).toEqual([{ key: result.key, body: 'DUMPBYTES' }]);
    expect(h.txUpdate).toHaveBeenCalledWith({
      where: { id: 'rec-tenant-1' },
      data: expect.objectContaining({ status: 'SUCCESS', key: result.key }),
    });
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'backup.run',
        after: expect.objectContaining({ status: 'SUCCESS', localPath: result.localPath }),
      }),
    );
  });

  it('schließt wie der Worker verwaiste RUNNING-Records (> 6 h) ab', async () => {
    await runBackup();

    expect(h.prismaOwner.backupRecord.updateMany).toHaveBeenCalledWith({
      where: { status: 'RUNNING', startedAt: { lt: expect.any(Date) } },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('verweigert einen Single-Tenant-Lauf außerhalb einer Single-Tenant-Installation', async () => {
    h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);

    await expect(runBackup({ singleTenantId: 'tenant-1' })).resolves.toEqual({
      ok: false,
      error: 'backup_scope_not_allowed',
    });
    expect(h.prismaOwner.backupRecord.create).not.toHaveBeenCalled();
    expect(h.uploads).toEqual([]);
  });
});
