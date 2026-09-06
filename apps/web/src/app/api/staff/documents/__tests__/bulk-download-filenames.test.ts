import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';

const mocks = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  inaccessibleClientIdsFor: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  fetchObjectBytes: vi.fn(),
  tx: { document: { findMany: vi.fn() } },
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ inaccessibleClientIdsFor: mocks.inaccessibleClientIdsFor }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage', () => ({
  fetchObjectBytes: mocks.fetchObjectBytes,
  streamObject: vi.fn(),
  sanitizeFilenameForHeader: (value: string) => value,
}));

import { GET } from '../download/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffAuth.mockResolvedValue({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } });
  mocks.inaccessibleClientIdsFor.mockResolvedValue([]);
  mocks.withTenantContext.mockImplementation(
    async (_context: unknown, callback: (tx: unknown) => unknown) => callback(mocks.tx),
  );
  mocks.evidenceRecord.mockResolvedValue({});
  mocks.fetchObjectBytes.mockImplementation(async (_bucket: string, key: string) =>
    Buffer.from(`original bytes of ${key}`),
  );
});

describe('Sammeldownload: Dateinamen dürfen keine anderen Dokumentbytes beim Entpacken ersetzen', () => {
  // Existing document access/version rules remain unchanged:
  // ACCESS-CLIENT-MODE-001, DOC-VERSION-IMMUTABILITY-001.
  it.each([
    {
      label: 'ein Originalname belegt den automatisch vergebenen Suffix',
      titles: ['beleg.pdf', 'beleg.pdf', 'beleg_1.pdf'],
    },
    {
      label: 'mehrere Originalnamen kollidieren mit generierten Suffixen',
      titles: ['beleg.pdf', 'beleg_1.pdf', 'beleg.pdf', 'beleg_2.pdf', 'beleg.pdf'],
    },
    { label: 'Groß-/Kleinschreibung auf Windows', titles: ['Beleg.pdf', 'beleg.pdf', 'BELEG.PDF'] },
    { label: 'kanonisch gleiche Unicode-Namen auf macOS', titles: ['Büro.pdf', 'Bu\u0308ro.pdf'] },
    {
      label: 'unterschiedliche Originalnamen werden gleich bereinigt',
      titles: ['beleg?.pdf', 'beleg*.pdf', 'beleg__1.pdf'],
    },
  ])('$label', async ({ titles }) => {
    const documents = titles.map((title, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title,
      mimeType: 'application/pdf',
      folderId: null,
      versions: [{ storageBucket: 'synthetic', storageKey: `document-${index}`, sizeBytes: 32n }],
    }));
    mocks.tx.document.findMany.mockResolvedValue(documents);
    const response = await GET(
      new NextRequest(
        `https://local.test/api/staff/documents/download?ids=${documents.map((document) => document.id).join(',')}`,
      ),
    );

    expect(response.status).toBe(200);
    const extracted = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const names = Object.keys(extracted);
    expect(names).toHaveLength(documents.length);
    expect(new Set(names.map((name) => name.normalize('NFC').toLowerCase())).size).toBe(
      documents.length,
    );
    expect(
      Object.values(extracted)
        .map((bytes) => Buffer.from(bytes).toString())
        .sort(),
    ).toEqual(
      documents.map((document) => `original bytes of ${document.versions[0]!.storageKey}`).sort(),
    );
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(documents.length);
  });
});
