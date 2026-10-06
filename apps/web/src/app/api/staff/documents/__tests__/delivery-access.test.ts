// Fachkatalog: ACCESS-CLIENT-MODE-001, DOC-PORTAL-SHARING-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  streamVerifiedObject: vi.fn(),
  fetchObjectHead: vi.fn(),
  tx: {
    document: { findFirst: vi.fn() },
    powerOfAttorney: { findFirst: vi.fn() },
  },
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: mocks.canAccessClientTx }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage', () => ({
  streamVerifiedObject: mocks.streamVerifiedObject,
  fetchObjectHead: mocks.fetchObjectHead,
  detectMimeFromMagicBytes: () => 'application/pdf',
  sanitizeFilenameForHeader: (value: string) => value,
}));

import { GET as downloadGet } from '../[id]/download/route';
import { GET as previewGet } from '../[id]/preview-url/route';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = { user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] } };

function params() {
  return { params: Promise.resolve({ id: DOCUMENT_ID }) };
}

// P-12: Nur Requests, die Dokumentbytes ausliefern, schreiben einen Abrufnachweis;
// der Metadaten-Request der Vorschau (ohne ?stream=1) nicht.
const ROUTES = [
  {
    name: 'preview-stream',
    audits: 1,
    call: () =>
      previewGet(
        new NextRequest(`http://localhost/api/staff/documents/${DOCUMENT_ID}/preview-url?stream=1`),
        params(),
      ),
  },
  {
    name: 'download',
    audits: 1,
    call: () =>
      downloadGet(
        new NextRequest(`http://localhost/api/staff/documents/${DOCUMENT_ID}/download`),
        params(),
      ),
  },
  {
    name: 'preview',
    audits: 0,
    call: () =>
      previewGet(
        new NextRequest(`http://localhost/api/staff/documents/${DOCUMENT_ID}/preview-url`),
        params(),
      ),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffAuth.mockResolvedValue(SESSION);
  mocks.canAccessClientTx.mockResolvedValue(true);
  mocks.tx.document.findFirst.mockResolvedValue({
    id: DOCUMENT_ID,
    title: 'Vertrag',
    mimeType: 'application/pdf',
    classification: 'GOBD_CONTRACT',
    clientId: 'client-1',
    versions: [
      {
        storageBucket: 'documents',
        storageKey: 'tenant/document',
        sha256: new Uint8Array(32).fill(2),
        sizeBytes: 5n,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    ],
  });
  mocks.tx.powerOfAttorney.findFirst.mockResolvedValue(null);
  mocks.evidenceRecord.mockResolvedValue({});
  mocks.withTenantContext.mockImplementation(
    async (_ctx: unknown, callback: (tx: unknown) => unknown) => callback(mocks.tx),
  );
  mocks.streamVerifiedObject.mockResolvedValue({
    body: 'bytes',
    contentLength: 5,
    contentType: null,
  });
  mocks.fetchObjectHead.mockResolvedValue(Buffer.from('%PDF-1.7'));
});

describe.each(ROUTES)('Staff document delivery: $name', ({ call, audits }) => {
  // DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001.
  it.each(['PENDING', 'INFECTED', 'ERROR', 'MISSING_COMPLETION'])(
    'blocks the newest %s version before audit or object access',
    async (state) => {
      const candidate = await mocks.tx.document.findFirst();
      const clean = candidate.versions[0];
      mocks.tx.document.findFirst.mockResolvedValue({
        ...candidate,
        versions: [
          {
            ...clean,
            scanStatus: state === 'MISSING_COMPLETION' ? 'CLEAN' : state,
            scanCompletedAt: state === 'MISSING_COMPLETION' ? null : clean.scanCompletedAt,
          },
          clean,
        ],
      });
      const response = await call();
      expect(response.status).toBe(404);
      expect(mocks.evidenceRecord).not.toHaveBeenCalled();
      expect(mocks.streamVerifiedObject).not.toHaveBeenCalled();
      expect(mocks.fetchObjectHead).not.toHaveBeenCalled();
    },
  );
  it('bindet Tenant-/Soft-Delete-Filter und das aktuelle Mandantenzugriffsgate ein', async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.tx.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DOCUMENT_ID, tenantId: 'tenant-1', deletedAt: null },
      }),
    );
    expect(mocks.canAccessClientTx).toHaveBeenCalledWith(mocks.tx, SESSION, 'client-1');
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(audits);
  });

  it('antwortet bei entzogenem Mandantenzugriff mit 404 vor Audit und Storage', async () => {
    mocks.canAccessClientTx.mockResolvedValue(false);

    const response = await call();

    expect(response.status).toBe(404);
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.tx.powerOfAttorney.findFirst).not.toHaveBeenCalled();
    expect(mocks.streamVerifiedObject).not.toHaveBeenCalled();
    expect(mocks.fetchObjectHead).not.toHaveBeenCalled();
  });
});
