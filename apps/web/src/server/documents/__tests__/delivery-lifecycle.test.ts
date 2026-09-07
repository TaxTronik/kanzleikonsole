// Fachkatalog: DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001, DOC-PORTAL-SHARING-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ withTenantContext: vi.fn(), record: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.record } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  streamObject: vi.fn(),
  fetchObjectBytes: vi.fn(),
  sanitizeFilenameForHeader: (value: string) => value,
}));
import { loadDocumentDelivery } from '../delivery';
import {
  createDocumentWithVersion,
  createPendingDocumentWithVersion,
  finalizePendingDocumentVersion,
} from '../upload-helpers';

const documentData = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '33333333-3333-4333-8333-333333333333',
  title: 'Ausgabe',
  classification: 'GOBD_INVOICE' as const,
  mimeType: 'application/pdf',
};
const prepared = {
  tier: 'GOBD' as const,
  tenantId: documentData.tenantId,
  targetBucket: 'gobd',
  targetKey: 'tenant/output.pdf',
  sha256: Buffer.alloc(32, 1),
  sizeBytes: 123n,
  immutable: true,
  retentionUntil: new Date('2035-01-01T00:00:00Z'),
  detectedMime: 'application/pdf',
};
const commit = { ...prepared, storageVersionId: 's3-version-1' };
const actorId = '22222222-2222-4222-8222-222222222222';

function fixture() {
  let savedDocument: Record<string, unknown> = {};
  let savedVersion: Record<string, unknown> = {};
  const tx = {
    document: {
      create: vi.fn(async ({ data }) => (savedDocument = { id: 'document-1', ...data })),
      findFirst: vi.fn(async () => ({ ...savedDocument, versions: [savedVersion] })),
    },
    documentVersion: {
      create: vi.fn(async ({ data }) => (savedVersion = { id: 'version-1', ...data })),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!Object.entries(where).every(([key, value]) => savedVersion[key] === value))
          return { count: 0 };
        Object.assign(savedVersion, data);
        return { count: 1 };
      }),
    },
    powerOfAttorney: { findFirst: vi.fn(async () => null) },
  };
  mocks.withTenantContext.mockImplementation(async (_ctx, callback) => callback(tx));
  return tx;
}

function load() {
  return loadDocumentDelivery({
    tenantId: documentData.tenantId,
    actorId,
    actorType: 'STAFF',
    documentId: 'document-1',
    action: 'document.download',
    request: new NextRequest('http://localhost/document'),
    where: { id: 'document-1', tenantId: documentData.tenantId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue({});
});

describe('document writer to delivery compatibility', () => {
  it('delivers the version produced by the completed-upload helper', async () => {
    const tx = fixture();
    await createDocumentWithVersion(tx as never, { documentData, commit, createdById: actorId });
    await expect(load()).resolves.toMatchObject({
      bucket: prepared.targetBucket,
      key: prepared.targetKey,
    });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('blocks the actual journal intent until its exact finalization succeeds', async () => {
    const tx = fixture();
    await createPendingDocumentWithVersion(tx as never, {
      documentData,
      prepared,
      createdById: actorId,
    });
    await expect(load()).resolves.toBeNull();
    expect(mocks.record).not.toHaveBeenCalled();
    await finalizePendingDocumentVersion(tx as never, {
      documentId: 'document-1',
      versionId: 'version-1',
      commit,
    });
    await expect(load()).resolves.toMatchObject({
      bucket: prepared.targetBucket,
      key: prepared.targetKey,
    });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('keeps finalized historical outputs readable without requiring a newly introduced storage version ID', async () => {
    const tx = fixture();
    await tx.document.create({ data: documentData });
    await tx.documentVersion.create({
      data: {
        storageBucket: 'gobd',
        storageKey: 'historical.pdf',
        storageVersionId: null,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date('2024-01-01T00:00:00Z'),
      },
    });
    await expect(load()).resolves.toMatchObject({ bucket: 'gobd', key: 'historical.pdf' });
  });
});
