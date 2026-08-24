// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    fetchObjectBytes: vi.fn(),
    commitBytesWithTier: vi.fn(),
    deleteObject: vi.fn(),
    deleteObjectVersion: vi.fn(),
    evidenceRecord: vi.fn(),
    assertClientAccessTx: vi.fn(),
    revalidatePath: vi.fn(),
    logError: vi.fn(),
    compensateStorageCommit: vi.fn(),
    txInitial: {
      document: { findFirst: vi.fn() },
      documentType: { findFirst: vi.fn() },
    },
    txCommit: {
      $queryRaw: vi.fn(),
      documentType: { findFirst: vi.fn() },
      documentVersion: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      document: { update: vi.fn() },
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  fetchObjectBytes: m.fetchObjectBytes,
  commitBytesWithTier: m.commitBytesWithTier,
  deleteObject: m.deleteObject,
  deleteObjectVersion: m.deleteObjectVersion,
  classificationToTier: (classification: string) => {
    if (classification.startsWith('GOBD_')) return 'GOBD';
    if (classification === 'GWG_EVIDENCE') return 'GWG';
    return 'NONE';
  },
  gobdRetentionYears: vi.fn(() => 8),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/storage/document-type', () => ({
  carrierClassification: (_tier: string, classification: string) => classification,
}));
vi.mock('@/server/storage/retag-policy', () => ({
  documentRetagDecision: vi.fn(() => 'RESTORE_WITH_LOCK'),
}));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: m.assertClientAccessTx,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler.',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: m.ActionError,
  staffActionGuard: m.staffActionGuard,
  withStaff: vi.fn(),
}));
vi.mock('@/server/logger', () => ({ log: { error: m.logError } }));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: m.compensateStorageCommit,
}));

import { retagDocumentAction } from '../actions';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = new Date('2026-01-10T00:00:00.000Z');

function initialDocument(immutable: boolean) {
  return {
    classification: immutable ? 'GWG_EVIDENCE' : 'GENERAL',
    documentTypeId: null,
    clientId: null,
    createdAt: CREATED_AT,
    documentType: null,
    versions: [
      {
        id: VERSION_ID,
        versionNo: 1,
        storageBucket: immutable ? 'gwg' : 'general',
        storageKey: 'old-key',
        storageVersionId: immutable ? 'old-version-id' : null,
        immutable,
        scanStatus: 'CLEAN',
      },
    ],
  };
}

function matchingLatest(immutable: boolean) {
  return {
    id: VERSION_ID,
    versionNo: 1,
    storageBucket: immutable ? 'gwg' : 'general',
    storageKey: 'old-key',
    storageVersionId: immutable ? 'old-version-id' : null,
    immutable,
    scanStatus: 'CLEAN',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: {},
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  let txCall = 0;
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    txCall += 1;
    return fn(txCall === 1 ? m.txInitial : m.txCommit);
  });
  m.txInitial.documentType.findFirst.mockResolvedValue(null);
  m.txCommit.$queryRaw.mockResolvedValue([
    {
      id: DOCUMENT_ID,
      clientId: null,
      classification: 'GWG_EVIDENCE',
      documentTypeId: null,
    },
  ]);
  m.fetchObjectBytes.mockResolvedValue(Buffer.from('document bytes'));
  m.commitBytesWithTier.mockResolvedValue({
    targetBucket: 'gobd',
    targetKey: 'new-key',
    storageVersionId: 'new-version-id',
    immutable: true,
    sha256: Buffer.alloc(32, 7),
    sizeBytes: 14n,
    retentionUntil: new Date('2035-01-01T00:00:00.000Z'),
  });
  m.txCommit.documentVersion.create.mockResolvedValue({ id: 'new-db-version' });
  m.txCommit.document.update.mockResolvedValue({});
  m.evidenceRecord.mockResolvedValue({});
  m.compensateStorageCommit.mockResolvedValue('JOURNALED');
});

describe('retagDocumentAction concurrency and immutable history', () => {
  it('aborts on latest-version drift before any DB mutation', async () => {
    m.txInitial.document.findFirst.mockResolvedValue(initialDocument(true));
    m.txCommit.documentVersion.findFirst.mockResolvedValue({
      ...matchingLatest(true),
      id: '33333333-3333-4333-8333-333333333333',
      versionNo: 2,
      storageKey: 'concurrent-key',
      storageVersionId: 'concurrent-version-id',
    });

    const result = await retagDocumentAction({
      documentId: DOCUMENT_ID,
      classification: 'GOBD_INVOICE',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Neue Dokumentversion während der Umklassifizierung erkannt. Bitte erneut versuchen.',
    });
    expect(m.txCommit.$queryRaw).toHaveBeenCalledTimes(1);
    expect(m.txCommit.documentVersion.create).not.toHaveBeenCalled();
    expect(m.txCommit.documentVersion.update).not.toHaveBeenCalled();
    expect(m.txCommit.document.update).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.deleteObject).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
    expect(m.compensateStorageCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'staff.document.retag',
        commit: expect.objectContaining({
          targetBucket: 'gobd',
          targetKey: 'new-key',
          storageVersionId: 'new-version-id',
        }),
      }),
    );
  });

  it('appends a protected version instead of updating an immutable old version', async () => {
    m.txInitial.document.findFirst.mockResolvedValue(initialDocument(true));
    m.txCommit.documentVersion.findFirst.mockResolvedValue(matchingLatest(true));

    const result = await retagDocumentAction({
      documentId: DOCUMENT_ID,
      classification: 'GOBD_INVOICE',
    });

    expect(result).toEqual({ ok: true });
    expect(m.txCommit.documentVersion.update).not.toHaveBeenCalled();
    expect(m.txCommit.documentVersion.create).toHaveBeenCalledWith({
      data: {
        documentId: DOCUMENT_ID,
        versionNo: 2,
        storageBucket: 'gobd',
        storageKey: 'new-key',
        storageVersionId: 'new-version-id',
        immutable: true,
        sha256: Buffer.alloc(32, 7),
        sizeBytes: 14n,
        scanStatus: 'CLEAN',
        scanCompletedAt: expect.any(Date),
        createdById: 'staff-1',
      },
    });
    expect(m.txCommit.document.update).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(m.deleteObject).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });
});
