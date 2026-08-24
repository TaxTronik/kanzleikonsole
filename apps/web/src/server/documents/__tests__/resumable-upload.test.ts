// Fachkatalog: DOC-UPLOAD-JOURNAL-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  prepareBytesCommitWithTier: vi.fn(),
  commitPreparedBytes: vi.fn(),
  recoverPreparedBytesCommit: vi.fn(),
  createPendingDocumentWithVersion: vi.fn(),
  finalizePendingDocumentVersion: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  prepareBytesCommitWithTier: m.prepareBytesCommitWithTier,
  commitPreparedBytes: m.commitPreparedBytes,
  recoverPreparedBytesCommit: m.recoverPreparedBytesCommit,
}));
vi.mock('@/server/documents/upload-helpers', () => ({
  createPendingDocumentWithVersion: m.createPendingDocumentWithVersion,
  finalizePendingDocumentVersion: m.finalizePendingDocumentVersion,
}));

import {
  persistResumableDocumentUpload,
  ResumableDocumentUploadError,
  ResumableDocumentUploadInvariantError,
  type ResumableDocumentUploadOptions,
} from '../resumable-upload';

const FILE_BYTES = Buffer.from('%PDF-1.7\n');
const RETENTION_UNTIL = new Date('2036-01-01T00:00:00.000Z');
const PREPARED = {
  tier: 'GOBD' as const,
  tenantId: 'tenant-1',
  targetBucket: 'gobd',
  targetKey: 'tenants/tenant-1/gobd/2026/07/document.bin',
  sha256: Buffer.alloc(32, 7),
  sizeBytes: BigInt(FILE_BYTES.length),
  immutable: true,
  retentionUntil: RETENTION_UNTIL,
  detectedMime: 'application/pdf',
};
const COMMITTED = { ...PREPARED, storageVersionId: 'storage-version-1' };

function pendingDocument() {
  return {
    id: 'document-1',
    retentionUntil: RETENTION_UNTIL,
    versions: [
      {
        id: 'version-1',
        versionNo: 1,
        storageBucket: PREPARED.targetBucket,
        storageKey: PREPARED.targetKey,
        storageVersionId: null,
        sha256: PREPARED.sha256,
        sizeBytes: PREPARED.sizeBytes,
        immutable: true,
        scanStatus: 'PENDING',
        scanCompletedAt: null,
      },
    ],
  };
}

function makeTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'document-1' }]),
    document: { findFirst: vi.fn().mockResolvedValue(pendingDocument()) },
  };
}

function makeOptions(
  overrides: Partial<ResumableDocumentUploadOptions> = {},
): ResumableDocumentUploadOptions {
  return {
    context: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    documentData: {
      id: 'document-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      title: 'Vollmacht',
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
    },
    resumeWhere: {
      clientId: 'client-1',
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
      deletedAt: null,
    },
    createdById: 'staff-1',
    storage: {
      tier: 'GOBD',
      classification: 'GOBD_CONTRACT',
      expectedMime: 'application/pdf',
    },
    readBytes: vi.fn().mockResolvedValue(FILE_BYTES),
    guardMutationTx: vi.fn().mockResolvedValue(undefined),
    assertDocumentAvailableTx: vi.fn().mockResolvedValue(undefined),
    recordPendingTx: vi.fn().mockResolvedValue(undefined),
    recordCompleteTx: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let tx: ReturnType<typeof makeTx>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = makeTx();
  m.withTenantContext.mockImplementation(
    async (_context: unknown, run: (client: typeof tx) => unknown) => run(tx),
  );
  m.prepareBytesCommitWithTier.mockResolvedValue(PREPARED);
  m.commitPreparedBytes.mockResolvedValue(COMMITTED);
  m.recoverPreparedBytesCommit.mockResolvedValue(null);
  m.createPendingDocumentWithVersion.mockResolvedValue({
    document: { id: 'document-1' },
    version: { id: 'version-1' },
  });
  m.finalizePendingDocumentVersion.mockResolvedValue(undefined);
});

describe('persistResumableDocumentUpload', () => {
  it('journalisiert vor dem Object-Write und finalisiert in einer zweiten Transaktion', async () => {
    const options = makeOptions();

    const result = await persistResumableDocumentUpload(options);

    expect(result).toEqual({
      documentId: 'document-1',
      versionId: 'version-1',
      source: 'created',
    });
    expect(m.prepareBytesCommitWithTier).toHaveBeenCalledWith(
      expect.objectContaining({ fileData: FILE_BYTES, tenantId: 'tenant-1', tier: 'GOBD' }),
    );
    expect(m.createPendingDocumentWithVersion).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        documentData: expect.objectContaining({ id: 'document-1', tenantId: 'tenant-1' }),
        prepared: PREPARED,
      }),
    );
    expect(m.recoverPreparedBytesCommit).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).toHaveBeenCalledWith({
      fileData: FILE_BYTES,
      prepared: PREPARED,
    });
    expect(m.finalizePendingDocumentVersion).toHaveBeenCalledWith(tx, {
      documentId: 'document-1',
      versionId: 'version-1',
      commit: COMMITTED,
    });
    expect(m.withTenantContext).toHaveBeenCalledTimes(2);
    expect(m.createPendingDocumentWithVersion.mock.invocationCallOrder[0]).toBeLessThan(
      m.commitPreparedBytes.mock.invocationCallOrder[0]!,
    );
    expect(m.commitPreparedBytes.mock.invocationCallOrder[0]).toBeLessThan(
      m.finalizePendingDocumentVersion.mock.invocationCallOrder[0]!,
    );
  });

  it('recoveriert einen PENDING-Intent unter Tenant-Lock ohne zweiten PUT', async () => {
    m.recoverPreparedBytesCommit.mockResolvedValue(COMMITTED);
    const options = makeOptions({ resumeDocumentId: 'document-1' });

    const result = await persistResumableDocumentUpload(options);

    expect(result.source).toBe('resumed-pending');
    expect(tx.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'document-1', tenantId: 'tenant-1' }),
      }),
    );
    expect(m.recoverPreparedBytesCommit).toHaveBeenCalledWith(PREPARED);
    expect(m.prepareBytesCommitWithTier).not.toHaveBeenCalled();
    expect(m.createPendingDocumentWithVersion).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
    expect(options.readBytes).not.toHaveBeenCalled();
    expect(options.assertDocumentAvailableTx).toHaveBeenCalledWith(tx, 'document-1');
    expect(m.finalizePendingDocumentVersion).toHaveBeenCalledTimes(1);
  });

  it('liest bei einem noch nicht geschriebenen Resume-Intent dieselben Bytes erneut', async () => {
    const options = makeOptions({ resumeDocumentId: 'document-1' });

    await persistResumableDocumentUpload(options);

    expect(m.recoverPreparedBytesCommit).toHaveBeenCalledWith(PREPARED);
    expect(options.readBytes).toHaveBeenCalledTimes(1);
    expect(m.commitPreparedBytes).toHaveBeenCalledWith({
      fileData: FILE_BYTES,
      prepared: PREPARED,
    });
  });

  it('uebernimmt einen bereits CLEANen Intent ohne Commit oder erneute Finalisierung', async () => {
    tx.document.findFirst.mockResolvedValue({
      ...pendingDocument(),
      versions: [
        {
          ...pendingDocument().versions[0],
          storageVersionId: 'storage-version-1',
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date('2026-07-16T10:00:00.000Z'),
        },
      ],
    });
    const options = makeOptions({ resumeDocumentId: 'document-1' });

    const result = await persistResumableDocumentUpload(options);

    expect(result.source).toBe('resumed-clean');
    expect(m.recoverPreparedBytesCommit).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
    expect(m.finalizePendingDocumentVersion).not.toHaveBeenCalled();
    expect(options.recordCompleteTx).not.toHaveBeenCalled();
    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
  });

  it('stoppt Cross-Tenant-Metadaten vor Scan, Journal und Storage-Write', async () => {
    const options = makeOptions({
      documentData: {
        ...makeOptions().documentData,
        tenantId: 'tenant-2',
      },
    });

    const failure = await persistResumableDocumentUpload(options).catch((error) => error);

    expect(failure).toBeInstanceOf(ResumableDocumentUploadError);
    expect(failure).toMatchObject({ phase: 'prepare', pendingDocumentId: undefined });
    expect(failure.cause).toBeInstanceOf(ResumableDocumentUploadInvariantError);
    expect(failure.cause).toMatchObject({ code: 'TENANT_CONTEXT_MISMATCH' });
    expect(m.withTenantContext).not.toHaveBeenCalled();
    expect(m.prepareBytesCommitWithTier).not.toHaveBeenCalled();
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
  });

  it('schreibt kein Objekt, wenn das atomare PENDING-Journal zurueckrollt', async () => {
    const options = makeOptions({
      recordPendingTx: vi.fn().mockRejectedValue(new Error('audit unavailable')),
    });

    const failure = await persistResumableDocumentUpload(options).catch((error) => error);

    expect(failure).toBeInstanceOf(ResumableDocumentUploadError);
    expect(failure).toMatchObject({ phase: 'journal', pendingDocumentId: undefined });
    expect(m.createPendingDocumentWithVersion).toHaveBeenCalledTimes(1);
    expect(m.commitPreparedBytes).not.toHaveBeenCalled();
    expect(m.finalizePendingDocumentVersion).not.toHaveBeenCalled();
  });

  it('behaelt nach Commit-Fehler die PENDING-ID und startet keine Finalisierung', async () => {
    m.commitPreparedBytes.mockRejectedValue(new Error('storage unavailable'));
    const options = makeOptions();

    const failure = await persistResumableDocumentUpload(options).catch((error) => error);

    expect(failure).toBeInstanceOf(ResumableDocumentUploadError);
    expect(failure).toMatchObject({ phase: 'commit', pendingDocumentId: 'document-1' });
    expect(options.recordPendingTx).toHaveBeenCalledTimes(1);
    expect(m.finalizePendingDocumentVersion).not.toHaveBeenCalled();
    expect(options.recordCompleteTx).not.toHaveBeenCalled();
  });

  it('behaelt nach Finalize-Fehler denselben Intent fuer den naechsten Resume', async () => {
    m.finalizePendingDocumentVersion.mockRejectedValue(new Error('database unavailable'));
    const options = makeOptions();

    const failure = await persistResumableDocumentUpload(options).catch((error) => error);

    expect(failure).toBeInstanceOf(ResumableDocumentUploadError);
    expect(failure).toMatchObject({ phase: 'finalize', pendingDocumentId: 'document-1' });
    expect(m.commitPreparedBytes).toHaveBeenCalledTimes(1);
    expect(options.recordPendingTx).toHaveBeenCalledTimes(1);
    expect(options.recordCompleteTx).not.toHaveBeenCalled();
  });

  it('meldet auch einen Complete-Audit-Rollback als resumierbaren Finalize-Fehler', async () => {
    const options = makeOptions({
      recordCompleteTx: vi.fn().mockRejectedValue(new Error('audit unavailable')),
    });

    const failure = await persistResumableDocumentUpload(options).catch((error) => error);

    expect(failure).toBeInstanceOf(ResumableDocumentUploadError);
    expect(failure).toMatchObject({ phase: 'finalize', pendingDocumentId: 'document-1' });
    expect(m.finalizePendingDocumentVersion).toHaveBeenCalledTimes(1);
    expect(options.recordCompleteTx).toHaveBeenCalledTimes(1);
  });

  it('bricht einen fremden oder fehlenden Resume-Intent am tenantgebundenen Lock ab', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    const options = makeOptions({ resumeDocumentId: 'document-1' });

    const failure = await persistResumableDocumentUpload(options).catch((error) => error);

    expect(failure).toBeInstanceOf(ResumableDocumentUploadError);
    expect(failure).toMatchObject({ phase: 'resume', pendingDocumentId: 'document-1' });
    expect(failure.cause).toMatchObject({ code: 'RESUME_NOT_FOUND' });
    expect(tx.document.findFirst).not.toHaveBeenCalled();
    expect(m.recoverPreparedBytesCommit).not.toHaveBeenCalled();
  });
});
