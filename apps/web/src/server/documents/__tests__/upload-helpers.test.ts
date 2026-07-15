import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/storage', () => ({ MAX_UPLOAD_BYTES: 25 * 1024 * 1024 }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }));

import {
  createDocumentWithVersion,
  createPendingDocumentWithVersion,
  finalizePendingDocumentVersion,
} from '../upload-helpers';

describe('createDocumentWithVersion', () => {
  it('persistiert zwingend dieselbe Retention wie der Storage-Commit', async () => {
    const retentionUntil = new Date('2035-01-01T00:00:00.000Z');
    const documentCreate = vi.fn().mockResolvedValue({ id: 'document-1' });
    const versionCreate = vi.fn().mockResolvedValue({ id: 'version-1' });
    const tx = {
      document: { create: documentCreate },
      documentVersion: { create: versionCreate },
    };

    await createDocumentWithVersion(tx as never, {
      documentData: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        title: 'Rechnung',
        classification: 'GOBD_INVOICE',
        mimeType: 'application/pdf',
        retentionUntil: null,
      },
      commit: {
        targetBucket: 'gobd',
        targetKey: 'tenant/rechnung.pdf',
        storageVersionId: 's3-version-1',
        sha256: Buffer.alloc(32, 1),
        sizeBytes: 123n,
        immutable: true,
        retentionUntil,
      },
      createdById: '22222222-2222-4222-8222-222222222222',
    });

    expect(documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ retentionUntil }),
    });
    expect(versionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: 'document-1',
        immutable: true,
        storageVersionId: 's3-version-1',
      }),
    });
  });
});

describe('zweiphasiger geschützter Upload', () => {
  const prepared = {
    tier: 'GOBD' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
    targetBucket: 'gobd',
    targetKey: 'tenants/tenant-1/gobd/2026/07/upload.bin',
    sha256: Buffer.alloc(32, 2),
    sizeBytes: 456n,
    immutable: true,
    retentionUntil: new Date('2033-01-01T00:00:00.000Z'),
    detectedMime: 'application/pdf',
  };

  it('persistiert Bucket, Schlüssel und Hash als PENDING vor dem Object-Store-Write', async () => {
    const documentCreate = vi.fn().mockResolvedValue({ id: 'document-pending' });
    const versionCreate = vi.fn().mockResolvedValue({ id: 'version-pending' });
    const tx = {
      document: { create: documentCreate },
      documentVersion: { create: versionCreate },
    };

    await createPendingDocumentWithVersion(tx as never, {
      documentData: {
        tenantId: prepared.tenantId,
        clientId: '33333333-3333-4333-8333-333333333333',
        title: 'Vollmacht',
        classification: 'GOBD_CONTRACT',
        mimeType: 'application/pdf',
      },
      prepared,
      createdById: '22222222-2222-4222-8222-222222222222',
    });

    expect(documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ retentionUntil: prepared.retentionUntil }),
    });
    expect(versionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: 'document-pending',
        storageBucket: prepared.targetBucket,
        storageKey: prepared.targetKey,
        storageVersionId: null,
        sha256: prepared.sha256,
        sizeBytes: prepared.sizeBytes,
        immutable: true,
        scanStatus: 'PENDING',
        scanCompletedAt: null,
      }),
    });
  });

  it('finalisiert per CAS ausschließlich die passende PENDING-Version', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { documentVersion: { updateMany } };
    const commit = { ...prepared, storageVersionId: 'storage-version-1' };

    await finalizePendingDocumentVersion(tx as never, {
      documentId: 'document-pending',
      versionId: 'version-pending',
      commit,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'version-pending',
        documentId: 'document-pending',
        storageBucket: prepared.targetBucket,
        storageKey: prepared.targetKey,
        scanStatus: 'PENDING',
        immutable: true,
      },
      data: {
        storageVersionId: 'storage-version-1',
        immutable: true,
        scanStatus: 'CLEAN',
        scanCompletedAt: expect.any(Date),
      },
    });

    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      finalizePendingDocumentVersion(tx as never, {
        documentId: 'document-pending',
        versionId: 'version-pending',
        commit,
      }),
    ).rejects.toThrow('DOCUMENT_UPLOAD_FINALIZE_CONFLICT');
  });
});
