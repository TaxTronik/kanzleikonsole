import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  commitBytesWithTier: vi.fn(),
  createDocumentWithVersion: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  getClientIp: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@taxtronik/config', () => ({
  env: { NEXTAUTH_URL: 'http://localhost:3000' },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: m.canAccessClientTx }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  classificationToTier: () => 'NONE',
  isGobdClassification: () => false,
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
  storageCommitErrorResponse: (e: unknown) =>
    NextResponse.json({ error: (e as Error).message }, { status: 500 }),
  createDocumentWithVersion: m.createDocumentWithVersion,
}));
vi.mock('@/server/storage/document-type', () => ({
  carrierClassification: (_tier: string, classificationKey: string | null) =>
    classificationKey ?? 'GENERAL',
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: m.getClientIp }));
vi.mock('@/server/logger', () => ({ log: m.log }));

import { POST } from '../route';

const SESSION = {
  user: {
    tenantId: 'tenant-1',
    staffId: 'staff-1',
  },
};

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_TYPE_ID = '22222222-2222-4222-8222-222222222222';

function makeRequest() {
  const fd = new FormData();
  fd.set('file', new Blob(['vertrag'], { type: 'text/plain' }), 'vertrag.txt');
  fd.set('title', 'Vertrag');
  fd.set('documentTypeId', DOCUMENT_TYPE_ID);
  fd.set('clientId', CLIENT_ID);

  return new NextRequest('http://localhost:3000/api/staff/documents/commit', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    body: fd,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffAuth.mockResolvedValue(SESSION);
  m.canAccessClientTx.mockResolvedValue(true);
  m.getClientIp.mockReturnValue('127.0.0.1');
  m.commitBytesWithTier.mockResolvedValue({
    targetBucket: 'docs-retain-none',
    targetKey: 'tenant-1/documents/raced.txt',
    sha256: Buffer.from('00'.repeat(32), 'hex'),
    sizeBytes: 7,
    immutable: true,
    retentionUntil: null,
    detectedMime: 'text/plain',
  });
});

describe('POST /api/staff/documents/commit - TOCTOU', () => {
  it('liefert 409, wenn eine Referenz nach Vorpruefung und Storage-Commit verschwindet', async () => {
    const preStorageTx = {
      documentType: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_TYPE_ID,
          tier: 'GOBD',
          classificationKey: 'GOBD_INVOICE',
          retentionYears: 8,
        }),
      },
      client: { findFirst: vi.fn().mockResolvedValue({ id: CLIENT_ID }) },
      riskAnalysis: { findFirst: vi.fn() },
      workflowItem: { findFirst: vi.fn() },
      documentFolder: { findFirst: vi.fn() },
    };
    const finalTx = {
      client: { findFirst: vi.fn().mockResolvedValue(null) },
      riskAnalysis: { findFirst: vi.fn() },
      workflowItem: { findFirst: vi.fn() },
      documentFolder: { findFirst: vi.fn() },
    };

    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn(preStorageTx),
      )
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(finalTx));

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'reference_changed',
      message: 'Referenz hat sich waehrend des Uploads geaendert.',
    });
    expect(m.commitBytesWithTier).toHaveBeenCalledTimes(1);
    expect(m.commitBytesWithTier).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
      }),
    );
    expect(m.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.emitN8nEvent).not.toHaveBeenCalled();
    expect(m.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'documents-commit',
        orphanedBucket: 'docs-retain-none',
        orphanedKey: 'tenant-1/documents/raced.txt',
      }),
      expect.any(String),
    );
  });
});
