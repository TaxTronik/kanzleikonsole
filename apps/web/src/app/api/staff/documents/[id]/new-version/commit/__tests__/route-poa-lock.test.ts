import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  commitBytesWithTier: vi.fn(),
  evidenceRecord: vi.fn(),
  getClientIp: vi.fn(),
  log: { error: vi.fn() },
}));

vi.mock('@taxtronik/config', () => ({
  env: { NEXTAUTH_URL: 'http://localhost:3000' },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: m.canAccessClientTx }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  classificationToTier: () => 'GOBD',
  gobdRetentionYears: () => 10,
  commitBytesWithTier: m.commitBytesWithTier,
}));
vi.mock('@/server/documents/upload-helpers', () => ({
  parseMultipartUpload: async (req: NextRequest) => {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'file_missing' }, { status: 400 }),
      };
    }
    return { ok: true, form, file };
  },
  storageCommitErrorResponse: (error: unknown) =>
    NextResponse.json({ error: (error as Error).message }, { status: 500 }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: m.getClientIp }));
vi.mock('@/server/logger', () => ({ log: m.log }));

import { POST } from '../route';

function makeRequest() {
  const form = new FormData();
  form.set('file', new Blob(['neue Version'], { type: 'application/pdf' }), 'vollmacht.pdf');
  form.set('mimeType', 'application/pdf');
  return new NextRequest(
    `http://localhost:3000/api/staff/documents/${DOCUMENT_ID}/new-version/commit`,
    {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: form,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffAuth.mockResolvedValue({
    user: { tenantId: 'tenant-1', staffId: 'staff-1' },
  });
  m.canAccessClientTx.mockResolvedValue(true);
  m.commitBytesWithTier.mockResolvedValue({
    targetBucket: 'docs-gobd',
    targetKey: 'tenant-1/poa/raced.pdf',
    sha256: Buffer.alloc(32, 0xab),
    sizeBytes: 12,
    immutable: true,
  });
});

describe('Neue Dokumentversion — PoA-Snapshot-Sperre', () => {
  it('sperrt bereits ab SENT und lädt keine neuen Bytes in den Speicher', async () => {
    const tx = {
      document: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_ID,
          tenantId: 'tenant-1',
          clientId: '22222222-2222-4222-8222-222222222222',
          classification: 'GOBD_CONTRACT',
        }),
      },
      powerOfAttorney: {
        findFirst: vi.fn().mockResolvedValue({ id: 'poa-1' }),
      },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
      fn(tx),
    );

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: DOCUMENT_ID }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'locked_by_poa' }),
    );
    expect(tx.powerOfAttorney.findFirst).toHaveBeenCalledWith({
      where: {
        documentId: DOCUMENT_ID,
        OR: [{ status: { in: ['SENT', 'SIGNED'] } }, { signingContentSnapshot: { not: null } }],
      },
      select: { id: true },
    });
    expect(m.commitBytesWithTier).not.toHaveBeenCalled();
  });

  it('verhindert auch das Rennen Versand zwischen Vorprüfung und Versionsinsert', async () => {
    const document = {
      id: DOCUMENT_ID,
      tenantId: 'tenant-1',
      clientId: '22222222-2222-4222-8222-222222222222',
      classification: 'GOBD_CONTRACT',
    };
    const preUploadTx = {
      document: { findFirst: vi.fn().mockResolvedValue(document) },
      powerOfAttorney: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const finalTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: DOCUMENT_ID }]),
      powerOfAttorney: { findFirst: vi.fn().mockResolvedValue({ id: 'poa-1' }) },
      documentVersion: { findFirst: vi.fn(), create: vi.fn() },
    };
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
        fn(preUploadTx),
      )
      .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) => fn(finalTx));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: DOCUMENT_ID }),
    });

    expect(response.status).toBe(409);
    expect(m.commitBytesWithTier).toHaveBeenCalledTimes(1);
    expect(finalTx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(finalTx.documentVersion.create).not.toHaveBeenCalled();
  });

  it('übernimmt typabhängige Frist und verlängert Document-Metadaten monoton', async () => {
    const retentionUntil = new Date('2035-01-01T00:00:00.000Z');
    m.commitBytesWithTier.mockResolvedValue({
      targetBucket: 'docs-gobd',
      targetKey: 'tenant-1/new-version.pdf',
      sha256: Buffer.alloc(32, 0xcd),
      sizeBytes: 12n,
      immutable: true,
      retentionUntil,
    });
    const document = {
      id: DOCUMENT_ID,
      clientId: '22222222-2222-4222-8222-222222222222',
      classification: 'GOBD_INVOICE',
      documentType: { tier: 'GOBD', retentionYears: 8 },
    };
    const preUploadTx = {
      document: { findFirst: vi.fn().mockResolvedValue(document) },
      powerOfAttorney: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const finalTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: DOCUMENT_ID }]),
      powerOfAttorney: { findFirst: vi.fn().mockResolvedValue(null) },
      documentVersion: {
        findFirst: vi.fn().mockResolvedValue({ versionNo: 1 }),
        create: vi.fn().mockResolvedValue({ id: 'version-2' }),
      },
      document: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
        fn(preUploadTx),
      )
      .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) => fn(finalTx));

    const response = await POST(makeRequest(), {
      params: Promise.resolve({ id: DOCUMENT_ID }),
    });

    expect(response.status).toBe(200);
    expect(m.commitBytesWithTier).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
      }),
    );
    expect(finalTx.document.updateMany).toHaveBeenCalledWith({
      where: {
        id: DOCUMENT_ID,
        OR: [{ retentionUntil: null }, { retentionUntil: { lt: retentionUntil } }],
      },
      data: { retentionUntil },
    });
  });
});
