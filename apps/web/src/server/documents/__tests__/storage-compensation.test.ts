import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  log: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { storageOrphan: { upsert: h.upsert } },
}));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/logger', () => ({ log: h.log }));

import { compensateStorageCommit } from '../storage-compensation';

function commit(overrides: Record<string, unknown> = {}) {
  return {
    targetBucket: 'general',
    targetKey: 'tenants/t-1/none/file.bin',
    storageVersionId: 'version-1',
    sha256: Buffer.alloc(32, 1),
    sizeBytes: 42n,
    immutable: false,
    retentionUntil: null,
    detectedMime: 'application/pdf',
    ...overrides,
  };
}

describe('storage compensation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.upsert.mockResolvedValue({});
  });

  it('journalisiert auch mutable Objekte statt sie nach mehrdeutigem COMMIT-ACK sofort zu löschen', async () => {
    await expect(
      compensateStorageCommit({
        tenantId: 'tenant-1',
        source: 'test.upload',
        commit: commit(),
        cause: new Error('db failed'),
      }),
    ).resolves.toBe('JOURNALED');

    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          immutable: false,
          cleanupError: null,
          failure: 'db failed',
        }),
      }),
    );
  });

  it('journalisiert mit vollständiger Objektidentität und setzt einen alten Abschluss zurück', async () => {
    await expect(
      compensateStorageCommit({
        tenantId: 'tenant-1',
        source: 'test.upload',
        commit: commit(),
        cause: new Error('P2002'),
      }),
    ).resolves.toBe('JOURNALED');

    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storageBucket_storageKey_storageVersionId: {
            storageBucket: 'general',
            storageKey: 'tenants/t-1/none/file.bin',
            storageVersionId: 'version-1',
          },
        },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          immutable: false,
          cleanupError: null,
          failure: 'P2002',
        }),
        update: expect.objectContaining({
          cleanupClaimedAt: null,
          cleanedAt: null,
          resolution: null,
        }),
      }),
    );
  });

  it('journalisiert Object-Lock-Objekte mit Retention für die spätere Prüfung', async () => {
    const retentionUntil = new Date('2034-01-01T00:00:00.000Z');

    await expect(
      compensateStorageCommit({
        tenantId: 'tenant-1',
        source: 'test.gobd',
        commit: commit({ immutable: true, retentionUntil }),
        cause: new Error('database unavailable'),
      }),
    ).resolves.toBe('JOURNALED');

    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ immutable: true, retentionUntil }),
      }),
    );
  });

  it('liefert LOG_ONLY und protokolliert vollständig, wenn auch das Journal scheitert', async () => {
    h.upsert.mockRejectedValue(new Error('database still unavailable'));

    await expect(
      compensateStorageCommit({
        tenantId: 'tenant-1',
        source: 'test.gobd',
        commit: commit({ immutable: true }),
        cause: new Error('database unavailable'),
      }),
    ).resolves.toBe('LOG_ONLY');

    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        storageBucket: 'general',
        storageKey: 'tenants/t-1/none/file.bin',
        storageVersionId: 'version-1',
        journalError: 'database still unavailable',
      }),
      expect.stringContaining('manual reconciliation required'),
    );
  });
});
