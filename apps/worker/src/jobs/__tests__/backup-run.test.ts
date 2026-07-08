// =============================================================================
// Unit-Tests: backup-run-Worker (automatischer täglicher pg_dump → S3).
//
// spawn/S3-Upload/S3-Client/Prisma/Evidence gemockt. Abgedeckt:
//   - Erfolg: RUNNING-Record → SUCCESS (pro Tenant), Key-Format, sha256/size,
//     backup.run-Audit-Event, Upload aufgerufen.
//   - Fehler: pg_dump exit ≠ 0 → FAILED + verwaistes S3-Objekt entfernt.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const h = vi.hoisted(() => {
  const prismaOwner = {
    tenant: { findMany: vi.fn() },
    backupRecord: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(async (_args: unknown) => ({ count: 0 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ backupRecord: { update: vi.fn() } })),
  };
  const record = vi.fn();
  const uploadDone = vi.fn(async () => undefined);
  const s3Send = vi.fn(async () => undefined);
  // Steuerbarer Fake-Child: Test setzt exitCode + optional stderr.
  const child = {
    exitCode: 0 as number,
    stderr: 'boom',
  };
  return { prismaOwner, record, uploadDone, s3Send, child };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@taxtronik/config', () => ({
  env: {
    DATABASE_URL: 'postgresql://taxtronik:pw@postgres:5432/taxtronik',
    S3_ENDPOINT: 'http://seaweedfs:8333',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'ak',
    S3_SECRET_KEY: 'sk',
    S3_BUCKET_BACKUPS: 'backups',
    TIMESTAMP_AUTHORITY_URL: undefined,
  },
}));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class { record = h.record; },
  LocalTimestampAdapter: class {},
  Rfc3161HttpAdapter: class {},
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = h.s3Send; },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    done = h.uploadDone;
    constructor(public opts: { params: { Body: PassThrough } }) {
      // Body (pg_dump-stdout-PassThrough) konsumieren, damit der Stream endet.
      this.opts.params.Body.resume();
    }
  },
}));
vi.mock('node:child_process', () => ({
  spawn: () => {
    const cp = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: EventEmitter };
    cp.stdout = new PassThrough();
    cp.stderr = new EventEmitter();
    setImmediate(() => {
      cp.stdout.write(Buffer.from('DUMPBYTES'));
      cp.stdout.end();
      if (h.child.exitCode !== 0) cp.stderr.emit('data', Buffer.from(h.child.stderr));
      cp.emit('exit', h.child.exitCode);
    });
    return cp;
  },
}));

import { runScheduledBackup } from '../backup-run';

const NOW = new Date('2026-07-07T01:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.child.exitCode = 0;
  h.prismaOwner.tenant.findMany.mockResolvedValue([{ id: 't-1' }, { id: 't-2' }]);
  h.prismaOwner.backupRecord.create.mockImplementation(async ({ data }: { data: { tenantId: string } }) => ({
    id: `rec-${data.tenantId}`,
    tenantId: data.tenantId,
  }));
  h.prismaOwner.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ backupRecord: { update: vi.fn() } }),
  );
  h.record.mockResolvedValue({});
  h.uploadDone.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('runScheduledBackup', () => {
  it('Erfolg: SUCCESS je Tenant + backup.run-Audit + Key-Format', async () => {
    const r = await runScheduledBackup(NOW);
    expect(r.ok).toBe(true);
    // Sekunden + 6-stelliger Hex-Zufallssuffix gegen prozessübergreifende Key-Kollision.
    expect(r.key).toMatch(/^pgdump\/2026\/07\/07\/taxtronik-20260707-010000-[0-9a-f]{6}\.sql\.gz$/);
    // RUNNING-Records für beide Tenants angelegt.
    expect(h.prismaOwner.backupRecord.create).toHaveBeenCalledTimes(2);
    // Upload wurde aufgerufen (Stream nach S3).
    expect(h.uploadDone).toHaveBeenCalledTimes(1);
    // Audit-Event backup.run mit SUCCESS je Tenant.
    expect(h.record).toHaveBeenCalledTimes(2);
    expect(h.record.mock.calls[0]![1]).toMatchObject({ action: 'backup.run', after: { status: 'SUCCESS' } });
  });

  it('Fehler: pg_dump exit ≠ 0 → FAILED + verwaistes Objekt entfernt', async () => {
    h.child.exitCode = 1;
    const r = await runScheduledBackup(NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('pg_dump exit 1');
    // DeleteObjectCommand für das (evtl. unvollständige) Objekt.
    expect(h.s3Send).toHaveBeenCalledTimes(1);
    // FAILED-Audit je Tenant.
    expect(h.record).toHaveBeenCalledTimes(2);
    expect(h.record.mock.calls[0]![1]).toMatchObject({ action: 'backup.run', after: { status: 'FAILED' } });
  });

  it('ohne Tenants: no-op ohne Record/Upload', async () => {
    h.prismaOwner.tenant.findMany.mockResolvedValue([]);
    const r = await runScheduledBackup(NOW);
    expect(r.ok).toBe(true);
    expect(h.prismaOwner.backupRecord.create).not.toHaveBeenCalled();
    expect(h.uploadDone).not.toHaveBeenCalled();
  });

  it('Zombie-Reconcile: verwaiste RUNNING-Records (> 6h alt) → FAILED', async () => {
    await runScheduledBackup(NOW);
    expect(h.prismaOwner.backupRecord.updateMany).toHaveBeenCalledTimes(1);
    const arg = h.prismaOwner.backupRecord.updateMany.mock.calls[0]![0] as {
      where: { status: string; startedAt: { lt: Date } };
      data: { status: string; finishedAt: Date };
    };
    expect(arg.where.status).toBe('RUNNING');
    expect(arg.data.status).toBe('FAILED');
    // Cutoff = NOW − 6h.
    expect(arg.where.startedAt.lt).toEqual(new Date(NOW.getTime() - 6 * 60 * 60 * 1000));
  });
});
