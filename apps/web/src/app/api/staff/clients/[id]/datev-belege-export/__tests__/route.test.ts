import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { strToU8, unzipSync, zipSync } from 'fflate';

const h = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  fetchObjectBytes: vi.fn(),
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
vi.mock('@taxtronik/storage', () => ({ fetchObjectBytes: h.fetchObjectBytes }));

import { GET } from '../route';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
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
    h.fetchObjectBytes.mockResolvedValue(original);

    const response = await call();
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const name = `belege/0001_Beleg.${extension}`;
    expect(Object.keys(files)).toEqual(['index.csv', 'manifest.txt', name]);
    expect(Buffer.from(files[name]!)).toEqual(original);
    expect(Buffer.from(files['index.csv']!).toString('utf8')).toContain(name);
  });

  it('liest ohne aktuellen Mandantenzugriff keine Dokumente oder Bytes', async () => {
    h.canAccessClientTx.mockResolvedValue(false);
    expect((await call()).status).toBe(404);
    expect(h.tx.document.findMany).not.toHaveBeenCalled();
    expect(h.fetchObjectBytes).not.toHaveBeenCalled();
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
      h.fetchObjectBytes.mockResolvedValue(Buffer.from('ready'));
      const response = await call();
      expect(response.status).toBe(200);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(Object.keys(files)).toEqual([
        'index.csv',
        'manifest.txt',
        'belege/0001_Freigegeben.pdf',
      ]);
      expect(Buffer.from(files['index.csv']!).toString()).not.toContain('Unvollstaendig');
      expect(h.fetchObjectBytes).toHaveBeenCalledExactlyOnceWith('synthetic', 'ready');
      expect(h.evidenceRecord.mock.calls[0]![1].after.documents).toBe(1);
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
    expect(h.fetchObjectBytes).not.toHaveBeenCalled();
  });

  it('behält gültige inklusive UTC-Filter einschließlich Schalttag bei', async () => {
    expect((await call('?from=2024-02-29&to=2024-02-29')).status).toBe(200);
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
