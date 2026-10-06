// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  return {
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    fetchObjectBytes: vi.fn(),
    prepare: vi.fn(),
    deleteObject: vi.fn(),
    deleteObjectVersion: vi.fn(),
    evidenceRecord: vi.fn(),
    assertClientAccessTx: vi.fn(),
    revalidatePath: vi.fn(),
    logError: vi.fn(),
    txInitial: {
      document: { findFirst: vi.fn() },
      documentType: { findFirst: vi.fn() },
    },
    txCommit: {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      documentType: { findFirst: vi.fn() },
      documentVersion: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      document: { update: vi.fn() },
    },
  };
});

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    UploadRejectedError: (await import('@taxtronik/storage/errors')).UploadRejectedError,
    fetchObjectBytes: m.fetchObjectBytes,
    prepareBytesCommitWithTier: m.prepare,
    commitPreparedBytes: storageJournal.commit,
    deleteObject: m.deleteObject,
    deleteObjectVersion: m.deleteObjectVersion,
    classificationToTier: (classification: string) => {
      if (classification.startsWith('GOBD_')) return 'GOBD';
      if (classification === 'GWG_EVIDENCE') return 'GWG';
      return 'NONE';
    },
    gobdRetentionYears: vi.fn(() => 8),
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/storage/document-type', () => ({
  carrierClassification: (_tier: string, classification: string) => classification,
}));
vi.mock('@/server/storage/retag-policy', () => ({
  documentRetagDecision: vi.fn(() => 'RESTORE_WITH_LOCK'),
}));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: m.assertClientAccessTx,
}));
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  staffActionGuard: m.staffActionGuard,
  withStaff: vi.fn(),
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(m.staffActionGuard),
}));
vi.mock('@/server/logger', () => ({ log: { error: m.logError, warn: vi.fn() } }));

import { retagDocumentAction } from '../actions';
import { storageJournal } from '@/server/documents/__tests__/storage-journal-fake';

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
  storageJournal.reset();
  m.prepare.mockImplementation(storageJournal.prepare);
  m.txCommit.$executeRaw.mockImplementation(storageJournal.executeRaw);
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
  m.txCommit.documentVersion.create.mockResolvedValue({ id: 'new-db-version' });
  m.txCommit.document.update.mockResolvedValue({});
  m.evidenceRecord.mockResolvedValue({});
});

describe('retagDocumentAction concurrency and immutable history', () => {
  it('aborts on latest-version drift before any DB mutation or object write', async () => {
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
    // K-06: Die gemeinsame Vorpruefung erkennt die Drift vor Scan, Journal und
    // Object-Write; es entsteht kein (unter Object Lock unloeschbares) Objekt.
    expect(m.fetchObjectBytes).not.toHaveBeenCalled();
    expect(storageJournal.events).toEqual([]);
  });

  it('keeps the journaled intent open when the version drifts after the object write', async () => {
    m.txInitial.document.findFirst.mockResolvedValue(initialDocument(true));
    m.txCommit.documentVersion.findFirst.mockResolvedValueOnce(matchingLatest(true));
    m.txCommit.documentVersion.findFirst.mockResolvedValueOnce({
      ...matchingLatest(true),
      id: '33333333-3333-4333-8333-333333333333',
      versionNo: 2,
    });

    const result = await retagDocumentAction({
      documentId: DOCUMENT_ID,
      classification: 'GOBD_INVOICE',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Neue Dokumentversion während der Umklassifizierung erkannt. Bitte erneut versuchen.',
    });
    expect(m.txCommit.documentVersion.create).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'staff.document.retag',
        storageKey: storageJournal.objects[0]!.key,
        storageVersionId: storageJournal.objects[0]!.versionId,
        immutable: true,
      }),
    ]);
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
    const stored = storageJournal.objects[0]!;
    expect(m.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
        retentionAnchor: CREATED_AT,
      }),
    );
    expect(m.txCommit.documentVersion.create).toHaveBeenCalledWith({
      data: {
        documentId: DOCUMENT_ID,
        versionNo: 2,
        storageBucket: stored.bucket,
        storageKey: stored.key,
        storageVersionId: stored.versionId,
        immutable: true,
        sha256: stored.sha256,
        sizeBytes: 14n,
        scanStatus: 'CLEAN',
        scanCompletedAt: expect.any(Date),
        createdById: 'staff-1',
      },
    });
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({ source: 'staff.document.retag', resolution: 'REFERENCED' }),
    ]);
    expect(m.txCommit.document.update).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(m.deleteObject).not.toHaveBeenCalled();
    expect(m.deleteObjectVersion).not.toHaveBeenCalled();
  });
});
