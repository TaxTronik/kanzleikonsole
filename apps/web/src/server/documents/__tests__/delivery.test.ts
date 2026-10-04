import { beforeEach, describe, expect, it, vi } from 'vitest';
// Fachkatalog: DOC-PORTAL-SHARING-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
import { NextRequest } from 'next/server';
import { streamObject, fetchObjectBytes } from '@taxtronik/storage';

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: mocks.getClientIp }));
vi.mock('@taxtronik/storage', () => ({
  sanitizeFilenameForHeader: (value: string) => value,
  streamObject: vi.fn(),
  fetchObjectBytes: vi.fn(),
  detectMimeFromMagicBytes: vi.fn(),
}));

import {
  loadDocumentDelivery,
  documentDownloadResponse,
  documentPreviewResponse,
} from '../delivery';

function transaction() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ allowed: false }]),
    document: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'document-1',
        title: 'Dokument',
        mimeType: 'application/pdf',
        classification: 'GOBD_CONTRACT',
        clientId: 'client-1',
        versions: [
          {
            storageBucket: 'documents',
            storageKey: 'tenant/document-1',
            storageVersionId: 'bound-s3-version',
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
          },
        ],
      }),
    },
    powerOfAttorney: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

const PREVIEW_URL = 'http://localhost/api/staff/documents/document-1/preview-url';

function options(url = PREVIEW_URL) {
  return {
    tenantId: 'tenant-1',
    actorId: 'staff-1',
    actorType: 'STAFF' as const,
    documentId: 'document-1',
    action: 'document.preview' as const,
    request: new NextRequest(url),
    where: { id: 'document-1', tenantId: 'tenant-1', deletedAt: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evidenceRecord.mockResolvedValue({});
});

describe('document delivery pipeline', () => {
  it('DOC-VERSION-IMMUTABILITY-001: reicht die gebundene Version in Download und Vorschau durch', async () => {
    const tx = transaction();
    mocks.withTenantContext.mockImplementation(async (_ctx, callback) => callback(tx));
    const document = await loadDocumentDelivery(options());
    expect(document?.storageVersionId).toBe('bound-s3-version');
    vi.mocked(streamObject).mockResolvedValue({
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      contentLength: 0,
      contentType: 'application/pdf',
    });
    await documentDownloadResponse(document!, { mimeSource: 'validated-document' });
    expect(streamObject).toHaveBeenCalledWith('documents', 'tenant/document-1', 'bound-s3-version');
    vi.mocked(fetchObjectBytes).mockResolvedValue(Buffer.from('%PDF-test'));
    await documentPreviewResponse(new NextRequest('http://localhost/doc?stream=1'), document!);
    expect(fetchObjectBytes).toHaveBeenCalledWith(
      'documents',
      'tenant/document-1',
      'bound-s3-version',
    );
  });
  it('requires fresh payroll rights even when a generic document lookup returned the artifact', async () => {
    const tx = transaction();
    tx.document.findFirst.mockResolvedValue({
      id: 'document-1',
      title: 'Personal',
      mimeType: 'application/pdf',
      classification: 'PERSONNEL',
      clientId: 'client-1',
      requiresPayrollAccess: true,
      versions: [
        {
          storageBucket: 'documents',
          storageKey: 'restricted',
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
        },
      ],
    } as never);
    mocks.withTenantContext.mockImplementation(async (_ctx, callback) => callback(tx));
    await expect(loadDocumentDelivery(options())).resolves.toBeNull();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValue([{ allowed: true }]);
    await expect(loadDocumentDelivery(options())).resolves.toMatchObject({ title: 'Personal' });
    await expect(
      loadDocumentDelivery({ ...options(), actorType: 'CLIENT_CONTACT' }),
    ).resolves.toBeNull();
  });
  it('verweigert vor Audit und PoA-Lookup, wenn das Surface-Gate ablehnt', async () => {
    const tx = transaction();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (value: unknown) => unknown) => callback(tx),
    );

    await expect(
      loadDocumentDelivery({ ...options(), authorize: async () => false }),
    ).resolves.toBeNull();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(tx.powerOfAttorney.findFirst).not.toHaveBeenCalled();
  });

  it('laesst den erforderlichen Audit-Eintrag atomar im Ladepfad fehlschlagen', async () => {
    const tx = transaction();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (value: unknown) => unknown) => callback(tx),
    );
    mocks.evidenceRecord.mockRejectedValue(new Error('audit unavailable'));

    await expect(loadDocumentDelivery(options(`${PREVIEW_URL}?stream=1`))).rejects.toThrow(
      'audit unavailable',
    );
    expect(mocks.withTenantContext).toHaveBeenCalledTimes(1);
  });

  it('isoliert best-effort Audit in einer zweiten Transaktion', async () => {
    const tx = transaction();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (value: unknown) => unknown) => callback(tx),
    );
    mocks.evidenceRecord.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      loadDocumentDelivery({ ...options(`${PREVIEW_URL}?stream=1`), auditFailure: 'ignore' }),
    ).resolves.toMatchObject({ title: 'Dokument', clientId: 'client-1' });
    expect(mocks.withTenantContext).toHaveBeenCalledTimes(2);
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(1);
  });

  it.each(['reject', 'ignore'] as const)(
    'P-12: Vorschau-Metadaten ohne, Byte-Stream mit genau einem Abrufnachweis (auditFailure=%s)',
    async (auditFailure) => {
      const tx = transaction();
      mocks.withTenantContext.mockImplementation(
        async (_ctx: unknown, callback: (value: unknown) => unknown) => callback(tx),
      );

      // Metadaten: dieselben Zugriffs- und Readiness-Prüfungen, aber kein Audit.
      await expect(loadDocumentDelivery({ ...options(), auditFailure })).resolves.toMatchObject({
        title: 'Dokument',
      });
      expect(tx.document.findFirst).toHaveBeenCalledTimes(1);
      expect(mocks.evidenceRecord).not.toHaveBeenCalled();
      expect(mocks.withTenantContext).toHaveBeenCalledTimes(1);

      // Byte-Stream der Vorschau: genau ein document.preview.
      await loadDocumentDelivery({ ...options(`${PREVIEW_URL}?stream=1`), auditFailure });
      expect(mocks.evidenceRecord).toHaveBeenCalledTimes(1);
      expect(mocks.evidenceRecord.mock.calls[0]![1]).toMatchObject({
        action: 'document.preview',
        resourceType: 'document',
        resourceId: 'document-1',
      });

      // Downloads liefern immer Bytes und bleiben unabhängig vom Query auditiert.
      await loadDocumentDelivery({ ...options(), action: 'document.download', auditFailure });
      expect(mocks.evidenceRecord).toHaveBeenCalledTimes(2);
      expect(mocks.evidenceRecord.mock.calls[1]![1].action).toBe('document.download');
    },
  );
});
