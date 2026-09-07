// Fachkatalog: DOC-VERSION-IMMUTABILITY-001 (finalisierte Ausgaben bleiben vollständig entpackbar).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  inaccessibleClientIdsFor: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  fetchObjectBytes: vi.fn(),
  tx: { document: { findMany: vi.fn() }, documentFolder: { findMany: vi.fn() } },
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
  mocks.tx.documentFolder.findMany.mockResolvedValue([]);
  mocks.fetchObjectBytes.mockImplementation(async (_bucket: string, key: string) =>
    Buffer.from(`original bytes of ${key}`),
  );
});

describe('Sammeldownload: Dateien dürfen keine benötigten Verzeichnispfade belegen', () => {
  // Transportregression; Zugriff und Versionbytes nach ACCESS-CLIENT-MODE-001
  // und DOC-VERSION-IMMUTABILITY-001 bleiben unverändert.
  it.each([
    { label: 'Datei und Wurzelordner', folderName: 'Belege', title: 'Belege' },
    {
      label: 'Datei und Elternpfad eines tieferen Ordners',
      folderName: 'Belege',
      title: 'Belege',
      nested: true,
    },
    {
      label: 'Datei im Ordner und gleichnamiger Unterordner',
      folderName: 'Belege',
      title: '2026',
      nested: true,
      fileInFolder: true,
    },
    { label: 'Groß-/Kleinschreibung', folderName: 'Belege', title: 'belege' },
    { label: 'kanonisch gleiche Unicode-Namen', folderName: 'Büro', title: 'Bu\u0308ro' },
    {
      label: 'ein weiterer Ordner belegt bereits den ersten Dateisuffix',
      folderName: 'Belege',
      title: 'Belege',
      extraReservedFolder: true,
    },
  ])('$label', async ({ folderName, title, nested, fileInFolder, extraReservedFolder }) => {
    const rootId = '00000000-0000-4000-8000-000000000101';
    const childId = '00000000-0000-4000-8000-000000000102';
    const extraId = '00000000-0000-4000-8000-000000000103';
    const folders: { id: string; name: string; parentId: string | null }[] = [
      { id: rootId, name: folderName, parentId: null },
    ];
    if (nested) folders.push({ id: childId, name: '2026', parentId: rootId });
    if (extraReservedFolder) folders.push({ id: extraId, name: `${folderName}_1`, parentId: null });
    const makeDocument = (
      index: number,
      name: string,
      folderId: string | null,
      mimeType: string,
    ) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: name,
      mimeType,
      folderId,
      versions: [
        {
          storageBucket: 'synthetic',
          storageKey: `document-${index}`,
          sizeBytes: 32n,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
        },
      ],
    });
    const collidingDocument = makeDocument(
      1,
      title,
      fileInFolder ? rootId : null,
      'application/octet-stream',
    );
    const looseDocuments = fileInFolder ? [] : [collidingDocument];
    const folderDocuments = [
      ...(fileInFolder ? [collidingDocument] : []),
      makeDocument(2, 'Original.pdf', nested ? childId : rootId, 'application/pdf'),
      ...(extraReservedFolder ? [makeDocument(3, 'Weiteres.pdf', extraId, 'application/pdf')] : []),
    ];
    mocks.tx.document.findMany.mockImplementation(async ({ where }: { where: { id?: unknown } }) =>
      where.id ? looseDocuments : folderDocuments,
    );
    mocks.tx.documentFolder.findMany.mockResolvedValue(folders);
    const query = new URLSearchParams({
      ids: looseDocuments.map((document) => document.id).join(','),
      folders: [rootId, ...(extraReservedFolder ? [extraId] : [])].join(','),
    });
    const response = await GET(
      new NextRequest(`https://local.test/api/staff/documents/download?${query}`),
    );
    expect(response.status).toBe(200);
    const extracted = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const names = Object.keys(extracted);
    const documents = [...looseDocuments, ...folderDocuments];
    expect(names).toHaveLength(documents.length);
    const fileKeys = new Set(names.map((name) => name.normalize('NFC').toLowerCase()));
    expect(fileKeys.size).toBe(documents.length);
    for (const name of names) {
      const parts = name.normalize('NFC').toLowerCase().split('/');
      for (let length = 1; length < parts.length; length += 1) {
        expect(fileKeys.has(parts.slice(0, length).join('/')), `Datei blockiert ${name}`).toBe(
          false,
        );
      }
    }

    // Den echten Routen-ZIP auch auf einem Dateisystem vollständig entpacken.
    const directory = await mkdtemp(join(tmpdir(), 'taxtronik-bulk-download-'));
    try {
      for (const [name, bytes] of Object.entries(extracted)) {
        const target = resolve(directory, name);
        expect(
          target.startsWith(`${resolve(directory)}/`) ||
            target.startsWith(`${resolve(directory)}\\`),
        ).toBe(true);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const contents = await Promise.all(
        names.map((name) => readFile(join(directory, name), 'utf8')),
      );
      expect(contents.sort()).toEqual(
        documents.map((document) => `original bytes of ${document.versions[0]!.storageKey}`).sort(),
      );
    } finally {
      expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
      expect(basename(directory).startsWith('taxtronik-bulk-download-')).toBe(true);
      await rm(directory, { recursive: true, force: true });
    }
    expect(mocks.evidenceRecord).toHaveBeenCalledTimes(documents.length);
  });
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
      versions: [
        {
          storageBucket: 'synthetic',
          storageKey: `document-${index}`,
          sizeBytes: 32n,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
        },
      ],
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
