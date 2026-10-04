// Fachkatalog: AUDIT-HASH-CHAIN-001, DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001
// P-12: Der Sammel-Download schreibt EIN Abrufnachweis-Ereignis pro Export statt
// eines je Dokument (jedes unter dem Tenant-Lock der Hash-Kette). Welche Dokumente
// das System verlassen haben, bleibt aus dem einen Ereignis vollständig ablesbar.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';

const h = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  read: vi.fn(),
  folders: vi.fn(),
  audit: vi.fn(),
  fetch: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('@/server/auth/staff', () => ({
  staffAuth: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ inaccessibleClientIdsFor: async () => [] }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage', () => ({
  fetchObjectBytes: h.fetch,
  streamObject: h.stream,
  sanitizeFilenameForHeader: (value: string) => value,
}));
import { GET } from '../download/route';

const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const doc = (index: number, folderId: string | null = FOLDER_ID) => ({
  id: uuid(index),
  folderId,
  title: `Beleg ${index}.pdf`,
  mimeType: 'application/pdf',
  versions: [
    {
      storageBucket: 'synthetic',
      storageKey: `key-${index}`,
      storageVersionId: null,
      sizeBytes: 8n,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
    },
  ],
});
const call = (query: string) =>
  GET(new NextRequest(`https://local.test/api/staff/documents/download?${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenantContext.mockImplementation(async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ document: { findMany: h.read }, documentFolder: { findMany: h.folders } }),
  );
  h.folders.mockResolvedValue([{ id: FOLDER_ID, name: 'Belege', parentId: null }]);
  h.audit.mockResolvedValue({});
  h.fetch.mockImplementation(async (_bucket: string, key: string) => Buffer.from(key));
  h.stream.mockResolvedValue({ body: 'bytes', contentLength: 5, contentType: 'application/pdf' });
});

describe('P-12: ein Abrufnachweis pro Sammel-Export', () => {
  it('2.000 Ordnerdokumente → genau ein Ereignis mit allen IDs in Archivreihenfolge', async () => {
    const documents = Array.from({ length: 2000 }, (_, index) => doc(index + 1));
    h.read.mockResolvedValue(documents);

    const response = await call(`folders=${FOLDER_ID}`);

    expect(response.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))).toHaveLength(2000);
    // Vorher 2.000 record()-Aufrufe (je Lock + Vorgänger-Lookup + Insert).
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [tx, event] = h.audit.mock.calls[0]!;
    expect(tx).toBeDefined();
    expect(event).toMatchObject({
      tenantId: 'tenant-1',
      actorType: 'STAFF',
      actorId: 'staff-1',
      action: 'document.download.bulk',
      resourceType: 'document',
      resourceId: null,
      after: { documentCount: 2000, folderIds: [FOLDER_ID] },
    });
    expect(event.after.documentIds).toEqual(documents.map((document) => document.id));
    // Eine Lese- und eine Audit-Transaktion, unabhängig von der Dokumentzahl.
    expect(h.withTenantContext).toHaveBeenCalledTimes(2);
  });

  it('ein zugleich einzeln und per Ordner gewähltes Dokument erscheint einmal im Nachweis', async () => {
    const both = doc(1);
    const onlyFolder = doc(2);
    h.read.mockImplementation(async ({ where }: { where: { id?: unknown } }) =>
      where.id ? [both] : [both, onlyFolder],
    );

    const response = await call(`ids=${both.id}&folders=${FOLDER_ID}`);

    expect(response.status).toBe(200);
    // Das Archiv enthält das Dokument an beiden gewählten Orten …
    expect(Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))).toEqual([
      'Beleg 1.pdf',
      'Belege/Beleg 1.pdf',
      'Belege/Beleg 2.pdf',
    ]);
    // … der Nachweis listet jedes ausgelieferte Dokument genau einmal.
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![1].after).toEqual({
      documentCount: 2,
      documentIds: [both.id, onlyFolder.id],
      folderIds: [FOLDER_ID],
    });
  });

  it('eine einzelne lose Datei bleibt ein document.download mit Ressourcen-ID', async () => {
    const single = doc(7, null);
    h.read.mockResolvedValue([single]);

    const response = await call(`ids=${single.id}`);

    expect(response.status).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: 'document.download',
      resourceType: 'document',
      resourceId: single.id,
    });
    expect(h.audit.mock.calls[0]![1].after).toBeUndefined();
  });
});
