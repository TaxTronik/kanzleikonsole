import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  audit: vi.fn(),
  stream: vi.fn(),
  fetch: vi.fn(),
  folders: vi.fn(),
}));
vi.mock('@/server/auth/staff', () => ({
  staffAuth: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ inaccessibleClientIdsFor: async () => [] }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => Promise<unknown>) =>
    run({ document: { findMany: h.read }, documentFolder: { findMany: h.folders } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage', () => ({
  fetchObjectBytes: h.fetch,
  streamObject: h.stream,
  sanitizeFilenameForHeader: (value: string) => value,
}));
import { GET } from '../download/route';

const id = '11111111-1111-4111-8111-111111111111';
const folderId = '22222222-2222-4222-8222-222222222222';
function document(key: string, scanStatus = 'CLEAN', scanCompletedAt: Date | null = new Date()) {
  return {
    id: key,
    folderId,
    title: key,
    mimeType: 'application/pdf',
    versions: [
      { storageBucket: 'synthetic', storageKey: key, sizeBytes: 5n, scanStatus, scanCompletedAt },
    ],
  };
}
const call = (query = `ids=${id}`) =>
  GET(new NextRequest(`https://local.test/api/staff/documents/download?${query}`));
beforeEach(() => {
  vi.clearAllMocks();
  h.fetch.mockResolvedValue(Buffer.from('ready'));
  h.stream.mockResolvedValue({ body: 'ready', contentLength: 5, contentType: 'application/pdf' });
  h.folders.mockResolvedValue([{ id: folderId, name: 'Belege', parentId: null }]);
});

describe('DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001: bulk download readiness', () => {
  it.each(['PENDING', 'INFECTED', 'ERROR', 'MISSING_COMPLETION'])(
    'does not stream the newest %s version or an older clean fallback',
    async (state) => {
      const blocked = document(
        'blocked',
        state === 'MISSING_COMPLETION' ? 'CLEAN' : state,
        state === 'MISSING_COMPLETION' ? null : new Date(),
      );
      blocked.versions.push(document('old-clean').versions[0]!);
      h.read.mockResolvedValue([blocked]);
      expect((await call()).status).toBe(404);
      expect(h.audit).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.stream).not.toHaveBeenCalled();
    },
  );
  it('keeps blocked loose and folder versions out of the actual ZIP and download audit', async () => {
    h.read.mockImplementation(async ({ where }) =>
      where.id
        ? [document('loose'), document('pending', 'PENDING')]
        : [document('folder'), document('quarantine', 'INFECTED')],
    );
    const response = await call(`ids=${id}&folders=${folderId}`);
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['loose.pdf', 'Belege/folder.pdf']);
    expect(h.fetch.mock.calls.map((call) => call[1])).toEqual(['loose', 'folder']);
    expect(h.audit.mock.calls.map((call) => call[1].resourceId)).toEqual(['loose', 'folder']);
  });
});
