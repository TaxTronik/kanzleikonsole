import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TOKEN = 'snapshot-token';
const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_SHA256 = Buffer.alloc(32, 0xab);

const snapshot = JSON.stringify({
  schemaVersion: 1,
  subject: 'Vollmacht Finanzamt',
  signerName: 'Sina Signer',
  signerEmail: 'signer@example.de',
  validFrom: '2026-08-01',
  validUntil: '2099-08-01',
  scope: null,
  document: {
    documentId: DOCUMENT_ID,
    versionId: VERSION_ID,
    sha256: DOCUMENT_SHA256.toString('hex'),
  },
});

const m = vi.hoisted(() => ({
  checkIpOrGlobalLimit: vi.fn(),
  getClientIp: vi.fn(),
  poaFindFirst: vi.fn(),
  versionFindFirst: vi.fn(),
  streamObject: vi.fn(),
}));

vi.mock('@/server/rate-limit', () => ({
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  getClientIp: m.getClientIp,
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    powerOfAttorney: { findFirst: m.poaFindFirst },
    documentVersion: { findFirst: m.versionFindFirst },
  },
}));
vi.mock('@taxtronik/storage', () => ({
  streamObject: m.streamObject,
  sanitizeFilenameForHeader: (value: string) => value,
}));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  m.checkIpOrGlobalLimit.mockResolvedValue({ ok: true });
  m.getClientIp.mockReturnValue('198.51.100.7');
  m.poaFindFirst.mockResolvedValue({
    id: 'poa-1',
    tenantId: 'tenant-1',
    documentId: DOCUMENT_ID,
    status: 'SENT',
    signingTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    signingContentSnapshot: snapshot,
    signingContentSha256: createHash('sha256').update(snapshot).digest(),
    signingDocumentVersionId: VERSION_ID,
  });
  m.versionFindFirst.mockResolvedValue({
    id: VERSION_ID,
    documentId: DOCUMENT_ID,
    sha256: DOCUMENT_SHA256,
    storageBucket: 'docs-gobd',
    storageKey: 'tenant-1/poa/version-1.pdf',
    document: {
      id: DOCUMENT_ID,
      tenantId: 'tenant-1',
      title: 'Vollmacht.pdf',
      mimeType: 'application/pdf',
      classification: 'GOBD_CONTRACT',
      deletedAt: null,
    },
  });
  m.streamObject.mockResolvedValue({
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-test'));
        controller.close();
      },
    }),
    contentLength: 9,
  });
});

describe('GET /poa/sign/document — Versand-Snapshot', () => {
  it('liefert ausschließlich die beim Versand gebundene Version', async () => {
    const response = await GET(
      new NextRequest(`http://localhost:3000/poa/sign/document?token=${TOKEN}`),
    );

    expect(response.status).toBe(200);
    expect(m.versionFindFirst).toHaveBeenCalledWith({
      where: {
        id: VERSION_ID,
        documentId: DOCUMENT_ID,
        document: { tenantId: 'tenant-1', deletedAt: null },
      },
      include: { document: true },
    });
    expect(m.streamObject).toHaveBeenCalledWith('docs-gobd', 'tenant-1/poa/version-1.pdf');
  });
});
