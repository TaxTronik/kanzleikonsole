import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  documentVersionFindFirst: vi.fn(),
  deleteObject: vi.fn(),
  deleteObjectVersion: vi.fn(),
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
  deleteObject: h.deleteObject,
  deleteObjectVersion: h.deleteObjectVersion,
}));

import { runStorageOrphanCleanup } from '../storage-orphan-cleanup';

const NOW = new Date('2026-08-23T12:00:00.000Z');

describe('storage orphan cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.findMany.mockResolvedValue([]);
    h.updateMany.mockResolvedValue({ count: 1 });
    h.documentVersionFindFirst.mockResolvedValue(null);
    h.deleteObject.mockResolvedValue(undefined);
    h.deleteObjectVersion.mockResolvedValue(undefined);
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
      },
    ]);
    h.deleteObject.mockRejectedValue(new Error('object lock still active'));

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
    expect(h.deleteObject).not.toHaveBeenCalled();
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
    expect(h.deleteObject).not.toHaveBeenCalled();
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
    expect(h.deleteObject).not.toHaveBeenCalled();
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
    expect(h.deleteObject).not.toHaveBeenCalled();
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
});
