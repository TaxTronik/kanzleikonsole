// Fachkatalog: DOC-VERSION-IMMUTABILITY-001, DOC-UPLOAD-JOURNAL-001
// P-03: Der Sammel-Download streamt das ZIP Objekt für Objekt aus S3 in die
// Antwort (exakte Local Header, kein Data Descriptor) und hält seinen Slot aus
// dem Stream-Pool, bis die Übertragung beendet oder abgebrochen ist.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';
import { readZipLikeStreamReader } from '@/server/export/__tests__/zip-format';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  folders: vi.fn(),
  audit: vi.fn(),
  stream: vi.fn(),
  releases: [] as Mock[],
  log: [] as string[],
}));
vi.mock('@/server/auth/staff', () => ({
  staffAuth: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ inaccessibleClientIdsFor: async () => [] }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ document: { findMany: h.read }, documentFolder: { findMany: h.folders } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  streamObject: h.stream,
  sanitizeFilenameForHeader: (value: string) => value,
}));
// Echter Slot; die Release-Funktion wird nur beobachtet.
vi.mock('@/server/export/zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/export/zip')>();
  return {
    ...actual,
    acquireZipStreamSlot: async () => {
      const realRelease = await actual.acquireZipStreamSlot();
      const release = vi.fn(() => {
        h.log.push('release');
        realRelease();
      });
      h.releases.push(release);
      return release;
    },
  };
});
import { GET } from '../download/route';

const CHUNK = 64 * 1024;
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const SIZE = 256 * 1024 + 7;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const doc = (index: number) => ({
  id: uuid(index),
  folderId: FOLDER_ID,
  title: `Beleg ${index}.pdf`,
  mimeType: 'application/pdf',
  versions: [
    {
      storageBucket: 'synthetic',
      storageKey: `key-${index}`,
      storageVersionId: `version-${index}`,
      sizeBytes: BigInt(SIZE),
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
    },
  ],
});
/** Langsames S3: ein Chunk, dann hängt das Objekt, während der Writer es puffert. */
function stallingBody(index: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) return new Promise<void>(() => undefined);
        sent = true;
        h.log.push(`open ${index}`);
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        h.log.push(`cancel ${index}`);
      },
    },
    { highWaterMark: 0 },
  );
}

/** S3-Body-Ersatz: erzeugt Bytes erst beim Lesen und protokolliert Öffnen/Ende/Abbruch. */
function objectBody(index: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === 0) h.log.push(`open ${index}`);
        if (offset >= SIZE) {
          h.log.push(`end ${index}`);
          controller.close();
          return;
        }
        const length = Math.min(CHUNK, SIZE - offset);
        controller.enqueue(new Uint8Array(length).fill(index));
        offset += length;
      },
      cancel() {
        h.log.push(`cancel ${index}`);
      },
    },
    { highWaterMark: 0 },
  );
}

const call = (init?: { signal?: AbortSignal }) =>
  GET(
    new NextRequest(`https://local.test/api/staff/documents/download?folders=${FOLDER_ID}`, init),
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.log.length = 0;
  h.releases.length = 0;
  h.folders.mockResolvedValue([{ id: FOLDER_ID, name: 'Belege', parentId: null }]);
  h.audit.mockResolvedValue({});
  h.stream.mockImplementation(async (_bucket: string, key: string) => ({
    body: objectBody(Number(key.slice('key-'.length))),
    contentLength: SIZE,
    contentType: 'application/pdf',
  }));
});

describe('P-03: Sammel-Download als Stream', () => {
  it('liest die Objekte nacheinander und gibt den Slot erst nach dem letzten Byte frei', async () => {
    const documents = Array.from({ length: 30 }, (_, index) => doc(index + 1));
    h.read.mockResolvedValue(documents);

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-length')).toBeNull();
    expect(h.releases).toHaveLength(1);
    expect(h.releases[0]).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(h.releases[0]).toHaveBeenCalledExactlyOnceWith('completed', undefined);
    // Je Objekt: öffnen, vollständig lesen, erst dann das nächste; der Slot wird
    // erst frei, nachdem das letzte Objekt übertragen ist.
    expect(h.log).toEqual([
      ...documents.flatMap((_, index) => [`open ${index + 1}`, `end ${index + 1}`]),
      'release',
    ]);
    // DOC-VERSION-IMMUTABILITY-001: gebundene S3-Version je Objekt.
    expect(h.stream.mock.calls).toEqual(
      documents.map((document) => [
        'synthetic',
        document.versions[0]!.storageKey,
        document.versions[0]!.storageVersionId,
      ]),
    );
    const zip = Buffer.concat(chunks);
    // Wie ein Stream-Leser: exakte Local Header (CRC-32, Größen), kein Data Descriptor.
    const local = readZipLikeStreamReader(zip);
    expect(local.map((entry) => entry.name)).toEqual(
      documents.map((document) => `Belege/${document.title}`),
    );
    expect(local.every((entry) => entry.size === SIZE && (entry.flags & 0x8) === 0)).toBe(true);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(documents.map((document) => `Belege/${document.title}`));
    documents.forEach((_, index) => {
      const bytes = files[`Belege/Beleg ${index + 1}.pdf`]!;
      expect(bytes.byteLength).toBe(SIZE);
      expect(bytes.every((byte) => byte === index + 1)).toBe(true);
    });
  });

  it('Client-Disconnect (req.signal): Slot frei, offenes Objekt geschlossen, kein weiteres geöffnet', async () => {
    h.read.mockResolvedValue([doc(1), doc(2), doc(3)]);
    h.stream.mockImplementation(async (_bucket: string, key: string) => ({
      body: stallingBody(Number(key.slice('key-'.length))),
      contentLength: SIZE,
      contentType: 'application/pdf',
    }));
    const disconnect = new AbortController();

    const response = await call({ signal: disconnect.signal });
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(h.log).toContain('open 1'));
    disconnect.abort(new Error('Client getrennt'));

    expect(h.releases[0]).toHaveBeenCalledExactlyOnceWith('cancelled', expect.any(Error));
    await expect(pendingRead).rejects.toThrow('Client getrennt');
    await vi.waitFor(() => expect(h.log).toContain('cancel 1'));
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('Abbruch durch den Konsumenten (Body-Cancel) gibt den Slot frei und schließt das Objekt', async () => {
    h.read.mockResolvedValue([doc(1), doc(2)]);
    h.stream.mockImplementation(async (_bucket: string, key: string) => ({
      body: stallingBody(Number(key.slice('key-'.length))),
      contentLength: SIZE,
      contentType: 'application/pdf',
    }));

    const response = await call();
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(h.log).toContain('open 1'));
    await reader.cancel();

    expect(h.releases[0]).toHaveBeenCalledExactlyOnceWith('cancelled', undefined);
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(h.log).toContain('cancel 1'));
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('nicht abrufbares späteres Objekt: Download bricht ab statt einer stillen Lücke, Slot frei', async () => {
    h.read.mockResolvedValue([doc(1), doc(2)]);
    h.stream.mockImplementation(async (_bucket: string, key: string) => {
      if (key === 'key-2') throw new Error('NoSuchVersion');
      return { body: objectBody(1), contentLength: SIZE, contentType: 'application/pdf' };
    });

    const response = await call();

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow('NoSuchVersion');
    expect(h.releases[0]).toHaveBeenCalledExactlyOnceWith(
      'failed',
      expect.objectContaining({ message: 'NoSuchVersion' }),
    );
  });
});
