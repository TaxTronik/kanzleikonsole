import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { readZipLikeStreamReader } from '@/server/export/__tests__/zip-format';

const h = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  streamObject: vi.fn(),
  checkStaffExportLimit: vi.fn(),
  tx: { client: { findFirst: vi.fn() }, document: { findMany: vi.fn() } },
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: h.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: h.canAccessClientTx }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '127.0.0.1',
  checkStaffExportLimit: h.checkStaffExportLimit,
}));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  streamObject: h.streamObject,
}));
// Echter ZIP-Writer; nur der Build-Slot ist für den 429-Pfad steuerbar.
vi.mock('@/server/export/zip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/export/zip')>();
  return { ...actual, acquireZipStreamSlot: vi.fn(actual.acquireZipStreamSlot) };
});

import { GET } from '../route';
import {
  acquireZipStreamSlot,
  ZipBusyError,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
} from '@/server/export/zip';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
/** Frischer S3-Body je Abruf (streamObject liefert einen Web-ReadableStream). */
const objectStream = (bytes: Uint8Array | string) => ({
  body: new Response(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)).body!,
  contentLength: null,
  contentType: null,
});
const call = (query = '') =>
  GET(
    new NextRequest(
      `https://local.test/api/staff/clients/${CLIENT_ID}/datev-belege-export${query}`,
    ),
    { params: Promise.resolve({ id: CLIENT_ID }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.staffAuth.mockResolvedValue({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', fullName: 'Synthetischer Test' },
  });
  h.canAccessClientTx.mockResolvedValue(true);
  h.checkStaffExportLimit.mockResolvedValue({ ok: true });
  h.withTenantContext.mockImplementation(async (_context: unknown, run: (tx: unknown) => unknown) =>
    run(h.tx),
  );
  h.tx.client.findFirst.mockResolvedValue({ id: CLIENT_ID, name: 'Testmandant', datevNo: '12345' });
  h.tx.document.findMany.mockResolvedValue([]);
});

describe('DATEV-Belege-Export: Dateityp und Originalinhalt', () => {
  // Transportregression: ACCESS-CLIENT-MODE-001 und DOC-VERSION-IMMUTABILITY-001.
  it.each([
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.SPREADSHEETML.SHEET', 'xlsx'],
    ['application/xml', 'xml'],
    ['application/pdf', 'pdf'],
    ['application/vnd.ms-excel', 'xls'],
  ])('exportiert %s mit der Endung %s und unveränderten Bytes', async (mimeType, extension) => {
    const original =
      extension === 'xlsx' || extension === 'docx'
        ? Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>') }))
        : Buffer.from('synthetic original bytes');
    h.tx.document.findMany.mockResolvedValue([
      {
        id: 'document-1',
        title: 'Beleg',
        mimeType,
        classification: 'GOBD_TAX',
        createdAt: new Date('2026-09-07T09:00:00Z'),
        invoiceAttachments: [],
        versions: [
          {
            storageBucket: 'synthetic',
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            storageKey: 'original',
            sizeBytes: BigInt(original.length),
            sha256: new Uint8Array(32),
          },
        ],
      },
    ]);
    h.streamObject.mockImplementation(async () => objectStream(original));

    const response = await call();
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const name = `belege/0001_Beleg.${extension}`;
    // P-03: index.csv/manifest.txt am Ende — sie weisen erst nach dem Streamen
    // aus, welche Belege tatsächlich geliefert wurden.
    expect(Object.keys(files)).toEqual([name, 'index.csv', 'manifest.txt']);
    expect(Buffer.from(files[name]!)).toEqual(original);
    expect(Buffer.from(files['index.csv']!).toString('utf8')).toContain(name);
  });

  it('liest ohne aktuellen Mandantenzugriff keine Dokumente oder Bytes', async () => {
    h.canAccessClientTx.mockResolvedValue(false);
    expect((await call()).status).toBe(404);
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    expect(h.streamObject).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001: only completed versions are exported', () => {
  it.each(['PENDING', 'INFECTED', 'ERROR', 'MISSING_COMPLETION'])(
    'omits the newest %s version without falling back to older bytes',
    async (state) => {
      const version = {
        storageBucket: 'synthetic',
        storageKey: 'ready',
        sizeBytes: 5n,
        sha256: new Uint8Array(32),
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      };
      const ready = {
        id: 'ready-document',
        title: 'Freigegeben',
        mimeType: 'application/pdf',
        classification: 'GOBD_TAX',
        createdAt: new Date(),
        invoiceAttachments: [],
        versions: [version],
      };
      h.tx.document.findMany.mockResolvedValue([
        ready,
        {
          ...ready,
          id: 'pending-document',
          title: 'Unvollstaendig',
          versions: [
            {
              ...version,
              storageKey: 'blocked',
              scanStatus: state === 'MISSING_COMPLETION' ? 'CLEAN' : state,
              scanCompletedAt: state === 'MISSING_COMPLETION' ? null : version.scanCompletedAt,
            },
            { ...version, storageKey: 'old-clean' },
          ],
        },
      ]);
      h.streamObject.mockImplementation(async () => objectStream('ready'));
      const response = await call();
      expect(response.status).toBe(200);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(Object.keys(files)).toEqual([
        'belege/0001_Freigegeben.pdf',
        'index.csv',
        'manifest.txt',
      ]);
      expect(Buffer.from(files['index.csv']!).toString()).not.toContain('Unvollstaendig');
      expect(h.streamObject).toHaveBeenCalledExactlyOnceWith('synthetic', 'ready', undefined);
      expect(h.evidenceRecord.mock.calls[0]![1].after).toMatchObject({
        documents: 1,
        documentIds: ['ready-document'],
      });
    },
  );
});

describe('DATEV-Belege-Export: echte Datumsgrenzen', () => {
  it.each([
    '?from=2026-02-30',
    '?to=2026-13-01',
    '?from=2025-02-29',
    '?from=2026-09-08&to=2026-09-07',
  ])('weist %s vor DB/Audit zurück', async (query) => {
    const response = await call(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_query' });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.streamObject).not.toHaveBeenCalled();
  });

  it('behält gültige inklusive UTC-Filter einschließlich Schalttag bei', async () => {
    const response = await call('?from=2024-02-29&to=2024-02-29');
    expect(response.status).toBe(200);
    // Body abnehmen: der gestreamte Export hält seinen Slot bis zum Ende.
    await response.arrayBuffer();
    expect(h.tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          clientId: CLIENT_ID,
          createdAt: {
            gte: new Date('2024-02-29T00:00:00.000Z'),
            lte: new Date('2024-02-29T23:59:59.999Z'),
          },
        }),
      }),
    );
  });
});

describe('F-18: Audit erst nach Größen-, Eintrags- und Slot-Prüfung', () => {
  // Fachkatalog: DOC-UPLOAD-JOURNAL-001 (Abrufnachweis nur für ausgelieferte Sammelausgaben).
  const readyDocument = (index: number, sizeBytes: bigint) => ({
    id: `document-${index}`,
    title: `Beleg ${index}`,
    mimeType: 'application/pdf',
    classification: 'GOBD_TAX',
    createdAt: new Date('2026-09-07T09:00:00Z'),
    invoiceAttachments: [],
    versions: [
      {
        storageBucket: 'synthetic',
        storageKey: `beleg-${index}`,
        sizeBytes,
        sha256: new Uint8Array(32),
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    ],
  });

  it('413 zip_too_large aus der DB-Größe: kein Audit, kein Slot, keine Bytes', async () => {
    h.tx.document.findMany.mockResolvedValue([
      readyDocument(1, BigInt(ZIP_MAX_TOTAL_BYTES)),
      readyDocument(2, 1n),
    ]);
    const response = await call();
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe('zip_too_large');
    expect(acquireZipStreamSlot).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.streamObject).not.toHaveBeenCalled();
  });

  it('413 zip_too_many_entries vorab statt nach Audit und Objekt-Loads', async () => {
    // Belege + index.csv + manifest.txt überschreiten das 16-Bit-EOCD-Feld.
    h.tx.document.findMany.mockResolvedValue(
      Array.from({ length: ZIP_MAX_ENTRIES - 1 }, (_, index) => readyDocument(index, 1n)),
    );
    const response = await call();
    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe('zip_too_many_entries');
    expect(acquireZipStreamSlot).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.streamObject).not.toHaveBeenCalled();
  });

  it('429 zip_busy: kein Audit und keine Bytes', async () => {
    vi.mocked(acquireZipStreamSlot).mockRejectedValueOnce(new ZipBusyError());
    h.tx.document.findMany.mockResolvedValue([readyDocument(1, 5n)]);
    const response = await call();
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe('zip_busy');
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.streamObject).not.toHaveBeenCalled();
  });

  it('auditiert genau einmal nach dem Slot-Erwerb und vor dem ersten Objekt-Load', async () => {
    h.tx.document.findMany.mockResolvedValue([readyDocument(1, 5n)]);
    h.streamObject.mockImplementation(async () => objectStream('bytes'));
    const response = await call('?from=2026-09-01&to=2026-09-30');
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(h.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(h.evidenceRecord.mock.calls[0]![1]).toMatchObject({
      action: 'client.belege.export',
      resourceType: 'client',
      resourceId: CLIENT_ID,
    });
    expect(h.evidenceRecord.mock.calls[0]![1].after).toEqual({
      documents: 1,
      documentIds: ['document-1'],
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const [slotOrder] = vi.mocked(acquireZipStreamSlot).mock.invocationCallOrder;
    const [auditOrder] = h.evidenceRecord.mock.invocationCallOrder;
    const [loadOrder] = h.streamObject.mock.invocationCallOrder;
    expect(slotOrder).toBeLessThan(auditOrder!);
    expect(auditOrder).toBeLessThan(loadOrder!);
    // Lesen (mit Zugriffsprüfung) und Audit laufen in getrennten Transaktionen.
    expect(h.withTenantContext).toHaveBeenCalledTimes(2);
  });
});

describe('P-03: DATEV-Belegexport als Stream', () => {
  // Fachkatalog: DOC-VERSION-IMMUTABILITY-001 (gebundene Version, unveränderte Originalbytes).
  const beleg = (index: number) => ({
    id: `document-${index}`,
    title: `Beleg ${index}`,
    mimeType: 'application/pdf',
    classification: 'GOBD_INVOICE',
    createdAt: new Date('2026-09-07T09:00:00Z'),
    invoiceAttachments: [],
    versions: [
      {
        storageBucket: 'synthetic',
        storageKey: `beleg-${index}`,
        storageVersionId: `version-${index}`,
        sizeBytes: 16n,
        sha256: new Uint8Array(32).fill(index),
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    ],
  });

  it('streamt die Belege, markiert fehlende im Index und gibt den Slot erst am Ende frei', async () => {
    const release = vi.fn();
    vi.mocked(acquireZipStreamSlot).mockResolvedValueOnce(release);
    h.tx.document.findMany.mockResolvedValue([beleg(1), beleg(2), beleg(3)]);
    h.streamObject.mockImplementation(async (_bucket: string, key: string) => {
      if (key === 'beleg-2') throw new Error('NoSuchKey');
      return objectStream(`bytes of ${key}`);
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBeNull();
    expect(release).not.toHaveBeenCalled();
    const zip = new Uint8Array(await response.arrayBuffer());
    expect(release).toHaveBeenCalledExactlyOnceWith('completed', undefined);
    // Wie ein Stream-Leser (z. B. Javas ZipInputStream in Importwerkzeugen):
    // exakte Local Header mit CRC-32 und Größen, kein Data Descriptor.
    expect(readZipLikeStreamReader(zip).map((entry) => entry.name)).toEqual([
      'belege/0001_Beleg 1.pdf',
      'belege/0003_Beleg 3.pdf',
      'index.csv',
      'manifest.txt',
    ]);
    const files = unzipSync(zip);
    expect(Buffer.from(files['belege/0003_Beleg 3.pdf']!).toString()).toBe('bytes of beleg-3');
    const indexRows = Buffer.from(files['index.csv']!).toString('utf8').split('\r\n');
    expect(indexRows).toHaveLength(4);
    expect(indexRows[2]).toMatch(/^0002;.*;FEHLT;$/);
    expect(indexRows[3]).toContain(`belege/0003_Beleg 3.pdf;${'03'.repeat(32)}`);
    expect(Buffer.from(files['manifest.txt']!).toString()).toContain(
      'Anzahl Belege: 2 (von 3 insgesamt)',
    );
    expect(h.streamObject.mock.calls).toEqual(
      [1, 2, 3].map((index) => ['synthetic', `beleg-${index}`, `version-${index}`]),
    );
  });

  it('bricht das Lesen eines Belegs mittendrin ab: wie bisher FEHLT im Index, Export läuft weiter', async () => {
    h.tx.document.findMany.mockResolvedValue([beleg(1), beleg(2), beleg(3)]);
    h.streamObject.mockImplementation(async (_bucket: string, key: string) => {
      if (key !== 'beleg-2') return objectStream(`bytes of ${key}`);
      let sent = false;
      return {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return controller.error(new Error('S3-Verbindung zurückgesetzt'));
            sent = true;
            controller.enqueue(new Uint8Array(10));
          },
        }),
        contentLength: null,
        contentType: null,
      };
    });

    const response = await call();
    const zip = new Uint8Array(await response.arrayBuffer());

    expect(readZipLikeStreamReader(zip).map((entry) => entry.name)).toEqual([
      'belege/0001_Beleg 1.pdf',
      'belege/0003_Beleg 3.pdf',
      'index.csv',
      'manifest.txt',
    ]);
    const files = unzipSync(zip);
    const indexRows = Buffer.from(files['index.csv']!).toString('utf8').split('\r\n');
    expect(indexRows[2]).toMatch(/^0002;.*;FEHLT;$/);
    expect(Buffer.from(files['manifest.txt']!).toString()).toContain(
      'Anzahl Belege: 2 (von 3 insgesamt)',
    );
  });

  it('Client-Disconnect gibt den Slot frei und schließt das gerade gelesene Objekt', async () => {
    const release = vi.fn();
    vi.mocked(acquireZipStreamSlot).mockResolvedValueOnce(release);
    h.tx.document.findMany.mockResolvedValue([beleg(1), beleg(2)]);
    let cancelled = 0;
    // Langsames S3: ein Chunk, dann hängt das Objekt, während der Writer puffert.
    h.streamObject.mockImplementation(async () => {
      let sent = false;
      return {
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (sent) return new Promise<void>(() => undefined);
              sent = true;
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled += 1;
            },
          },
          { highWaterMark: 0 },
        ),
        contentLength: null,
        contentType: null,
      };
    });
    const disconnect = new AbortController();

    const response = await GET(
      new NextRequest(`https://local.test/api/staff/clients/${CLIENT_ID}/datev-belege-export`, {
        signal: disconnect.signal,
      }),
      { params: Promise.resolve({ id: CLIENT_ID }) },
    );
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await vi.waitFor(() => expect(h.streamObject).toHaveBeenCalledTimes(1));
    disconnect.abort();

    expect(release).toHaveBeenCalledExactlyOnceWith('cancelled', expect.anything());
    await expect(pendingRead).rejects.toBeDefined();
    await vi.waitFor(() => expect(cancelled).toBe(1));
    expect(h.streamObject).toHaveBeenCalledTimes(1);
  });
});

// Fachkatalog: DOC-VERSION-IMMUTABILITY-001, DOC-UPLOAD-JOURNAL-001 — Produktentscheidung
// A10 (2026-10-07): Der DATEV-Belegexport weist wie `document.download.bulk` alle
// exportierten Dokument-IDs in einem Abrufnachweis aus (Archivreihenfolge, keine
// Kürzung; die Eintragsprüfung vor dem Nachweis begrenzt die Liste).
describe('A10: Abrufnachweis des DATEV-Belegexports mit Dokument-IDs', () => {
  const beleg = (index: number) => ({
    id: `document-${index}`,
    title: `Beleg ${index}`,
    mimeType: 'application/pdf',
    classification: 'GOBD_TAX',
    createdAt: new Date('2026-09-07T09:00:00Z'),
    invoiceAttachments: [],
    versions: [
      {
        storageBucket: 'synthetic',
        storageKey: `beleg-${index}`,
        storageVersionId: null,
        sizeBytes: 4n,
        sha256: new Uint8Array(32),
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      },
    ],
  });

  it('listet alle Belege in Archivreihenfolge, auch einen erst beim Streamen fehlenden', async () => {
    h.tx.document.findMany.mockResolvedValue([beleg(3), beleg(1), beleg(2)]);
    h.streamObject.mockImplementation(async (_bucket: string, key: string) => {
      if (key === 'beleg-1') throw new Error('NoSuchKey');
      return objectStream(key);
    });

    const response = await call();
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));

    expect(h.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(h.evidenceRecord.mock.calls[0]![1].after).toEqual({
      documents: 3,
      documentIds: ['document-3', 'document-1', 'document-2'],
      from: null,
      to: null,
    });
    // Die laufende Nummer in index.csv folgt derselben Reihenfolge.
    const indexRows = Buffer.from(files['index.csv']!).toString('utf8').split('\r\n');
    expect(indexRows[1]).toMatch(/^0001;.*;belege\/0001_Beleg 3\.pdf;/);
    expect(indexRows[2]).toMatch(/^0002;.*;FEHLT;$/);
    expect(indexRows[3]).toMatch(/^0003;.*;belege\/0003_Beleg 2\.pdf;/);
  });

  it('kürzt die Liste nicht: 2.000 Belege in genau einem Ereignis', async () => {
    const documents = Array.from({ length: 2000 }, (_, index) => beleg(index + 1));
    h.tx.document.findMany.mockResolvedValue(documents);
    h.streamObject.mockImplementation(async (_bucket: string, key: string) => objectStream(key));

    const response = await call();
    await response.arrayBuffer();

    expect(h.evidenceRecord).toHaveBeenCalledTimes(1);
    const { after } = h.evidenceRecord.mock.calls[0]![1];
    expect(after.documents).toBe(2000);
    expect(after.documentIds).toEqual(documents.map((document) => document.id));
  });
});
