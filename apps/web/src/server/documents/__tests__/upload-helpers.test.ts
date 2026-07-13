import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/storage', () => ({ MAX_UPLOAD_BYTES: 100 * 1024 * 1024 }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }));

import { createDocumentWithVersion } from '../upload-helpers';

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
