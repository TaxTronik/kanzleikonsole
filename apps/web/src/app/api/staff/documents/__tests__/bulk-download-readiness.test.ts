import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  audit: vi.fn(),
  stream: vi.fn(),
  folders: vi.fn(),
}));
vi.mock('@/server/auth/staff', () => ({
  staffAuth: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: async () => ({}) }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => Promise<unknown>) =>
    run({ document: { findMany: h.read }, documentFolder: { findMany: h.folders } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  streamVerifiedObject: h.stream,
  sanitizeFilenameForHeader: (value: string) => value,
}));
// Echter ZIP-Writer; nur der Build-Slot ist für den 429-Pfad steuerbar.
vi.mock('@/server/export/zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/export/zip')>();
  return { ...actual, acquireZipStreamSlot: vi.fn(actual.acquireZipStreamSlot) };
});
import { GET } from '../download/route';
import {
  acquireZipStreamSlot,
  ZipBusyError,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
} from '@/server/export/zip';

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
  // Frischer S3-Body je Abruf; der ZIP-Export streamt ihn, der Einzeldownload reicht ihn durch.
  h.stream.mockImplementation(async () => ({
    body: new Response('ready').body,
    contentLength: 5,
    contentType: 'application/pdf',
  }));
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
    expect(h.stream.mock.calls.map((call) => call[0].key)).toEqual(['loose', 'folder']);
    // P-12: EIN Abrufnachweis mit genau den ausgelieferten Dokumenten.
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: 'document.download.bulk',
      resourceId: null,
      after: { documentCount: 2, documentIds: ['loose', 'folder'], folderIds: [folderId] },
    });
  });
});

describe('F-18 / Befund 15: Abrufnachweis erst nach Größen-, Eintrags- und Slot-Prüfung', () => {
  // Fachkatalog: DOC-UPLOAD-JOURNAL-001 (Abrufnachweis nur für ausgelieferte Sammelausgaben).
  const sized = (key: string, sizeBytes: bigint) => {
    const doc = document(key);
    doc.versions[0]!.sizeBytes = sizeBytes;
    return doc;
  };

  it('413 aus der DB-Größe: kein Audit, kein Slot, keine Bytes', async () => {
    h.read.mockResolvedValue([sized('a', BigInt(ZIP_MAX_TOTAL_BYTES)), sized('b', 1n)]);
    const response = await call();
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe('zip_too_large');
    expect(acquireZipStreamSlot).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
  });

  it('413 bei zu vielen Einträgen vorab statt nach Audit und Objekt-Loads', async () => {
    h.read.mockResolvedValue(
      Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, index) => document(`doc-${index}`)),
    );
    const response = await call();
    expect(response.status).toBe(413);
    expect(acquireZipStreamSlot).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
  });

  it('429 zip_busy: kein Abrufnachweis für einen nie ausgelieferten Download', async () => {
    vi.mocked(acquireZipStreamSlot).mockRejectedValueOnce(new ZipBusyError());
    h.read.mockResolvedValue([document('a'), document('b')]);
    const response = await call();
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('zip_busy');
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
  });

  it('auditiert nach dem Slot-Erwerb und vor dem ersten Objekt-Load', async () => {
    h.read.mockResolvedValue([document('a'), document('b')]);
    const response = await call();
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const [slotOrder] = vi.mocked(acquireZipStreamSlot).mock.invocationCallOrder;
    const [auditOrder] = h.audit.mock.invocationCallOrder;
    const [loadOrder] = h.stream.mock.invocationCallOrder;
    expect(slotOrder).toBeLessThan(auditOrder!);
    expect(auditOrder).toBeLessThan(loadOrder!);
  });
});
