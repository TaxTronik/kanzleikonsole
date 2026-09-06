import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  documentVersionFindFirst: vi.fn(),
  deleteObjectVersion: vi.fn(),
  recoverPreparedBytesCommit: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    storageOrphan: { findMany: h.findMany, updateMany: h.updateMany },
    documentVersion: { findFirst: h.documentVersionFindFirst },
  },
}));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('@taxtronik/storage', () => ({
  deleteObjectVersion: h.deleteObjectVersion,
  recoverPreparedBytesCommit: h.recoverPreparedBytesCommit,
}));

import { runStorageOrphanCleanup } from '../storage-orphan-cleanup';

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('storage orphan cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.findMany.mockResolvedValue([]);
    h.updateMany.mockResolvedValue({ count: 1 });
    h.documentVersionFindFirst.mockResolvedValue(null);
    h.deleteObjectVersion.mockResolvedValue(undefined);
    h.recoverPreparedBytesCommit.mockResolvedValue(null);
  });

  it('DOC-UPLOAD-JOURNAL-001 lets later recoverable objects progress past a full batch of permanent errors', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      id: `orphan-${i}`,
      tenantId: 't-1',
      storageBucket: 'general',
      storageKey: `tenants/t-1/${i}`,
      storageVersionId: i === 100 ? 'healthy-version' : '',
      sha256: Buffer.alloc(32),
      sizeBytes: 1n,
      immutable: false,
      retentionUntil: null,
      createdAt: new Date(NOW.getTime() - 3_600_000 + i),
      cleanedAt: null as Date | null,
      cleanupClaimedAt: null as Date | null,
      cleanupAttempts: 0,
    }));
    h.findMany.mockImplementation(
      async ({
        orderBy,
        take,
      }: {
        orderBy: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
        take: number;
      }) =>
        rows
          .filter((r) => !r.cleanedAt)
          .sort((a, b) => {
            for (const clause of Array.isArray(orderBy) ? orderBy : [orderBy]) {
              const [key, direction] = Object.entries(clause)[0]!;
              const left = a[key as 'cleanupAttempts'];
              const right = b[key as 'cleanupAttempts'];
              const order = left < right ? -1 : left > right ? 1 : 0;
              if (order) return direction === 'asc' ? order : -order;
            }
            return 0;
          })
          .slice(0, take),
    );
    h.updateMany.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        const { cleanupAttempts, ...fields } = data;
        Object.assign(row, fields);
        if (cleanupAttempts)
          row.cleanupAttempts += (cleanupAttempts as { increment: number }).increment;
        return { count: 1 };
      },
    );
    expect((await runStorageOrphanCleanup(NOW)).failed).toBe(100);
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect((await runStorageOrphanCleanup(NOW)).deleted).toBe(1);
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'general',
      'tenants/t-1/100',
      'healthy-version',
    );
    expect(rows[100]!.cleanedAt).not.toBeNull();
  });

  it('selektiert Object-Lock-Orphans erst nach Retention und löscht versionsgenau', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/file.bin',
        storageVersionId: 'locked-version-1',
      },
    ]);

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      referenced: 0,
      incidents: 0,
      failed: 0,
    });

    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cleanedAt: null,
          createdAt: { lte: new Date('2026-08-23T11:30:00.000Z') },
          AND: [
            {
              OR: [
                { cleanupClaimedAt: null },
                { cleanupClaimedAt: { lte: new Date('2026-08-23T11:30:00.000Z') } },
              ],
            },
            { OR: [{ immutable: false }, { retentionUntil: { lte: NOW } }] },
          ],
        },
      }),
    );
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'gobd',
      'tenants/t-1/gobd/file.bin',
      'locked-version-1',
    );
    expect(h.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'orphan-1',
        cleanedAt: null,
        createdAt: { lte: new Date('2026-08-23T11:30:00.000Z') },
        AND: [
          {
            OR: [
              { cleanupClaimedAt: null },
              { cleanupClaimedAt: { lte: new Date('2026-08-23T11:30:00.000Z') } },
            ],
          },
          { OR: [{ immutable: false }, { retentionUntil: { lte: NOW } }] },
        ],
      },
      data: { cleanupClaimedAt: expect.any(Date) },
    });
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cleanedAt: expect.any(Date),
          cleanupClaimedAt: null,
          resolution: 'DELETED',
          cleanupAttempts: { increment: 1 },
        }),
      }),
    );
  });

  it('gibt den Claim nach Delete-Fehler frei und persistiert den Fehler für Retry', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: '',
        sha256: Buffer.alloc(32, 0x31),
        sizeBytes: 123n,
        immutable: false,
        retentionUntil: null,
      },
    ]);
    h.recoverPreparedBytesCommit.mockResolvedValue({
      targetBucket: 'general',
      targetKey: 'tenants/t-1/general/key',
      storageVersionId: 'recovered-version-1',
      sha256: Buffer.alloc(32, 0x31),
      sizeBytes: 123n,
      immutable: false,
      retentionUntil: null,
      detectedMime: null,
    });
    h.deleteObjectVersion.mockRejectedValue(new Error('object lock still active'));

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      failed: 1,
    });
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          cleanupClaimedAt: null,
          cleanupAttempts: { increment: 1 },
          cleanupError: 'object lock still active',
        },
      }),
    );
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'general',
      'tenants/t-1/general/key',
      'recovered-version-1',
    );
  });

  it('löscht nicht, wenn das Retention-Gate beim atomaren Claim inzwischen verloren ist', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 0,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      failed: 0,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenCalledOnce();
  });

  it('markiert eine persistierte DocumentVersion als REFERENCED und löscht nie das Objekt', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.documentVersionFindFirst.mockResolvedValue({
      id: 'document-version-1',
      document: { tenantId: 't-1' },
    });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 1,
      incidents: 0,
      failed: 0,
    });

    expect(h.documentVersionFindFirst).toHaveBeenCalledWith({
      where: {
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        OR: [{ storageVersionId: 'version-1' }, { storageVersionId: null }],
      },
      select: { id: true, document: { select: { tenantId: true } } },
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolution: 'REFERENCED', cleanedAt: expect.any(Date) }),
      }),
    );
  });

  it('löscht bei fehlgeschlagener DB-Referenzprüfung nicht und gibt den Claim frei', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.documentVersionFindFirst.mockRejectedValue(new Error('database unavailable'));

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      failed: 1,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cleanupClaimedAt: null,
          cleanupError: 'database unavailable',
        }),
      }),
    );
  });

  it('markiert einen Cross-Tenant-Treffer als Integritätsvorfall statt ihn still aufzulösen', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-1/general/key',
        storageVersionId: 'version-1',
      },
    ]);
    h.documentVersionFindFirst.mockResolvedValue({
      id: 'document-version-foreign',
      document: { tenantId: 't-2' },
    });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 1,
      failed: 0,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolution: 'INTEGRITY_INCIDENT',
          cleanupError: 'INTEGRITY_CROSS_TENANT_STORAGE_REFERENCE',
        }),
      }),
    );
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't-1', referencedTenantId: 't-2' }),
      expect.stringContaining('cross-tenant'),
    );
  });

  it('markiert einen Tenant/Key-Prefix-Mismatch als Integritätsvorfall', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-1',
        tenantId: 't-1',
        storageBucket: 'general',
        storageKey: 'tenants/t-2/general/key',
        storageVersionId: 'version-1',
      },
    ]);

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 1,
      failed: 0,
    });
    expect(h.documentVersionFindFirst).not.toHaveBeenCalled();
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolution: 'INTEGRITY_INCIDENT',
          cleanupError: 'INTEGRITY_TENANT_KEY_PREFIX_MISMATCH',
        }),
      }),
    );
  });

  it('DOC-UPLOAD-JOURNAL-001 bindet eine eindeutig recoverte Version vor der physischen Löschung', async () => {
    const sha256 = Buffer.alloc(32, 0x41);
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-resume',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/pending.bin',
        storageVersionId: '',
        sha256,
        sizeBytes: 456n,
        immutable: true,
        retentionUntil: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    h.recoverPreparedBytesCommit.mockResolvedValue({
      targetBucket: 'gobd',
      targetKey: 'tenants/t-1/gobd/pending.bin',
      storageVersionId: 'recovered-version-2',
      sha256,
      sizeBytes: 456n,
      immutable: true,
      retentionUntil: new Date('2026-08-01T00:00:00.000Z'),
      detectedMime: null,
    });

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      referenced: 0,
      incidents: 0,
      failed: 0,
    });

    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'orphan-resume',
          storageVersionId: '',
        }),
        data: { storageVersionId: 'recovered-version-2' },
      }),
    );
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'gobd',
      'tenants/t-1/gobd/pending.bin',
      'recovered-version-2',
    );
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolution: 'DELETED' }),
      }),
    );
  });

  it('DOC-VERSION-IMMUTABILITY-001 löscht bei mehrdeutiger Recovery keine Version', async () => {
    h.findMany.mockResolvedValue([
      {
        id: 'orphan-ambiguous',
        tenantId: 't-1',
        storageBucket: 'gobd',
        storageKey: 'tenants/t-1/gobd/ambiguous.bin',
        storageVersionId: '',
        sha256: Buffer.alloc(32, 0x51),
        sizeBytes: 789n,
        immutable: true,
        retentionUntil: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    h.recoverPreparedBytesCommit.mockRejectedValue(new Error('PREPARED_UPLOAD_MULTIPLE_VERSIONS'));

    await expect(runStorageOrphanCleanup(NOW)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      referenced: 0,
      incidents: 0,
      failed: 1,
    });
    expect(h.deleteObjectVersion).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cleanupClaimedAt: null,
          cleanupError: 'PREPARED_UPLOAD_MULTIPLE_VERSIONS',
        }),
      }),
    );
  });
});
