import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Fachkatalog: INV-ARCHIVE-EINVOICE-001, INV-PORTAL-SHARING-001

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  readModules: vi.fn(),
  checkStaffExportLimit: vi.fn(),
  withTenantContext: vi.fn(),
  canAccessClientTx: vi.fn(),
  ensureZugferdArchive: vi.fn(),
  readSellerInfo: vi.fn(),
  streamObject: vi.fn(),
  evidenceRecord: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/settings/modules', () => ({
  readModules: m.readModules,
  isModeModuleEnabled: (cfg: { invoiceMode: string }) => cfg.invoiceMode !== 'OFF',
}));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: m.checkStaffExportLimit,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: m.canAccessClientTx }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@taxtronik/storage', () => ({
  streamObject: m.streamObject,
  commitBytesWithTier: vi.fn(),
  fetchObjectBytes: vi.fn(),
}));
vi.mock('@/server/settings/tenant-settings', () => ({ readSellerInfo: m.readSellerInfo }));
vi.mock('@/server/logger', () => ({ log: { error: m.logError } }));
// Schwere Abhängigkeiten des Archivpfads; die Route nutzt daraus nur die
// echten Prüfungen, das Käufer-Mapping und den Recheck.
vi.mock('@/server/invoicing/zugferd', () => ({
  generateZugferdPdf: vi.fn(),
  extractFacturXXml: vi.fn(),
}));
vi.mock('@/server/settings/branding', () => ({ readBranding: vi.fn() }));
vi.mock('@/server/settings/letterhead', () => ({ readLetterhead: vi.fn() }));
vi.mock('@/server/documents/storage-compensation', () => ({ compensateStorageCommit: vi.fn() }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (bytes: unknown) => bytes }));
vi.mock('@/server/invoicing/archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/invoicing/archive')>()),
  ensureZugferdArchive: m.ensureZugferdArchive,
}));

import { GET } from '../route';
import { archiveFailureMessage } from '@/server/invoicing/archive-failure';

const INVOICE_ID = '3f2a1c88-5d4e-4b0a-9c11-7e6d5a4b3c2d';
const UPDATED_AT = new Date('2026-09-01T10:00:00.000Z');

const SELLER = {
  name: 'Kanzlei Muster',
  street: 'Weg 1',
  postalCode: '12345',
  city: 'Stadt',
  countryIso: 'DE',
  vatId: 'DE123456789',
  taxNumber: null,
  email: 'mail@kanzlei.example',
  phone: '+49 30 1',
  iban: null,
  bic: null,
  bankName: null,
};

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    tenantId: 'tenant-1',
    clientId: 'client-1',
    number: 'R-2026/0001',
    issueDate: new Date('2026-09-01T00:00:00.000Z'),
    dueDate: new Date('2026-09-15T00:00:00.000Z'),
    status: 'DRAFT',
    format: 'XRECHNUNG',
    subject: 'Beratung September',
    netAmount: 100,
    vatAmount: 19,
    totalAmount: 119,
    vatRate: 19,
    servicePeriodStart: null,
    servicePeriodEnd: null,
    vatExemptionReason: null,
    reverseCharge: false,
    notes: null,
    sentAt: null,
    documentId: null,
    xrechnungDocumentId: null,
    document: null,
    updatedAt: UPDATED_AT,
    stornoOfId: null,
    stornoOf: null,
    client: {
      name: 'Mandant GmbH',
      street: 'Gasse 2',
      postalCode: '54321',
      city: 'Ort',
      countryIso: 'DE',
      vatId: 'DE987654321',
      invoiceEmail: 'rechnung@mandant.example',
    },
    positions: [
      {
        position: 1,
        description: 'Beratung',
        quantity: 1,
        unit: 'Stunde',
        unitPrice: 100,
        netAmount: 100,
        vatRate: 19,
      },
    ],
    ...overrides,
  };
}

const SENT = {
  status: 'SENT',
  sentAt: new Date('2026-09-02T08:00:00.000Z'),
  updatedAt: new Date('2026-09-02T08:00:00.000Z'),
};
const ARCHIVED_XML = {
  id: 'xml-doc',
  sharedWithClientAt: new Date('2026-09-02T08:00:00.000Z'),
  versions: [{ storageBucket: 'gobd', storageKey: 'xml-key', storageVersionId: 'v1' }],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tx: any;

function request() {
  return GET(new NextRequest(`http://localhost:3000/api/staff/invoices/${INVOICE_ID}/xrechnung`), {
    params: Promise.resolve({ id: INVOICE_ID }),
  });
}

async function expectFailure(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({
    error: code,
    message: archiveFailureMessage(code as Parameters<typeof archiveFailureMessage>[0]),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    invoice: { findFirst: vi.fn() },
    document: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  m.staffAuth.mockResolvedValue({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } });
  m.readModules.mockResolvedValue({ invoiceMode: 'IN_APP' });
  m.checkStaffExportLimit.mockResolvedValue({ ok: true });
  m.canAccessClientTx.mockResolvedValue(true);
  m.readSellerInfo.mockResolvedValue(SELLER);
  m.streamObject.mockResolvedValue({ body: '<archiviert/>', contentLength: 13 });
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (client: unknown) => unknown) =>
    fn(tx),
  );
});

describe('GET /api/staff/invoices/[id]/xrechnung – DRAFT-Vorschau', () => {
  it('rendert die Vorschau mit dem gemeinsamen Käufer-Mapping und archiviert nichts', async () => {
    const draft = invoice();
    tx.invoice.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(draft);

    const response = await request();

    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain('<rsm:CrossIndustryInvoice');
    expect(xml).toContain('Mandant GmbH');
    expect(xml).toContain('DE987654321');
    expect(xml).toContain('rechnung@mandant.example');
    expect(m.ensureZugferdArchive).not.toHaveBeenCalled();
    expect(m.streamObject).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'invoice.xrechnung.download',
        after: { number: 'R-2026/0001', format: 'XRechnung 3.0', draftPreview: true },
      }),
    );
  });

  const INCOMPLETE: Array<[string, () => void, ReturnType<typeof invoice>]> = [
    [
      'seller_incomplete',
      () => {
        m.readSellerInfo.mockResolvedValue({ ...SELLER, phone: null });
      },
      invoice(),
    ],
    [
      'reverse_charge_seller_no_vatid',
      () => {
        m.readSellerInfo.mockResolvedValue({ ...SELLER, vatId: null, taxNumber: '012/345' });
      },
      invoice({ reverseCharge: true }),
    ],
    [
      'buyer_incomplete',
      () => undefined,
      invoice({ client: { ...invoice().client, postalCode: null } }),
    ],
  ];
  it.each(INCOMPLETE)(
    '%s → 422 mit Grund, ohne Rendern und Recheck',
    async (code, arrange, draft) => {
      arrange();
      tx.invoice.findFirst.mockResolvedValueOnce(draft);

      await expectFailure(await request(), code, 422);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(m.evidenceRecord).not.toHaveBeenCalled();
    },
  );

  it('not_applicable für einen PDF-Entwurf (wie die ZUGFeRD-Route)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(invoice({ format: 'PDF' }));

    await expectFailure(await request(), 'not_applicable', 404);
    expect(m.readSellerInfo).not.toHaveBeenCalled();
  });

  it('status_conflict, wenn der Entwurf während des Renderns storniert wurde', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice())
      .mockResolvedValueOnce(invoice({ status: 'CANCELLED', updatedAt: new Date() }));

    await expectFailure(await request(), 'status_conflict', 409);
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('status_conflict, wenn der Entwurf während des Renderns geändert wurde', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice())
      .mockResolvedValueOnce(invoice({ updatedAt: new Date('2026-09-01T10:00:01.000Z') }));

    await expectFailure(await request(), 'status_conflict', 409);
  });

  it('not_found, wenn die Rechnung während des Renderns verschwand', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(invoice()).mockResolvedValueOnce(null);

    await expectFailure(await request(), 'not_found', 404);
  });

  it('liefert die kanonische Archiv-XML, wenn die Ausstellung das Rendern überholt hat', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice())
      .mockResolvedValueOnce(
        invoice({
          ...SENT,
          documentId: 'pdf-doc',
          xrechnungDocumentId: 'xml-doc',
          document: { versions: [{ storageBucket: 'gobd', storageKey: 'pdf-key' }] },
        }),
      )
      .mockResolvedValueOnce({ ...SENT, xrechnungDocument: ARCHIVED_XML });

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('<archiviert/>');
    expect(m.streamObject).toHaveBeenCalledWith('gobd', 'xml-key', 'v1');
    expect(m.ensureZugferdArchive).not.toHaveBeenCalled();
  });
});

describe('GET /api/staff/invoices/[id]/xrechnung – ausgestellte Rechnung', () => {
  it('streamt die archivierte XML', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice(SENT))
      .mockResolvedValueOnce({ ...SENT, xrechnungDocument: ARCHIVED_XML });

    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="xrechnung-R-2026_0001.xml"',
    );
    expect(m.streamObject).toHaveBeenCalledWith('gobd', 'xml-key', 'v1');
    expect(m.readSellerInfo).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['not_applicable', 404],
    ['seller_incomplete', 422],
    ['reverse_charge_seller_no_vatid', 422],
    ['buyer_incomplete', 422],
    ['status_conflict', 409],
  ] as const)('Archivpfad meldet %s → %i mit Grund', async (code, status) => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice(SENT))
      .mockResolvedValueOnce({ ...SENT, xrechnungDocument: null });
    m.ensureZugferdArchive.mockResolvedValue({ ok: false, code });

    await expectFailure(await request(), code, status);
    expect(m.ensureZugferdArchive).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      INVOICE_ID,
      { purpose: 'ISSUE' },
    );
    expect(m.logError).not.toHaveBeenCalled();
  });

  it('generation_failed: Fehlertext nur im Server-Log, nicht im Body', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice(SENT))
      .mockResolvedValueOnce({ ...SENT, xrechnungDocument: null });
    m.ensureZugferdArchive.mockRejectedValue(
      new Error('ZUGFeRD-PDF-Generierung fehlgeschlagen: font /srv/app/fonts/x.ttf missing'),
    );

    const response = await request();

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: 'generation_failed',
      message: archiveFailureMessage('generation_failed'),
    });
    expect(text).not.toContain('/srv/app');
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'xrechnung',
        invoiceId: INVOICE_ID,
        err: 'ZUGFeRD-PDF-Generierung fehlgeschlagen: font /srv/app/fonts/x.ttf missing',
      }),
      expect.any(String),
    );
  });

  it('archive_failed, wenn die XML nach dem Archivpfad nicht verknüpft ist', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(invoice(SENT))
      .mockResolvedValueOnce({ ...SENT, xrechnungDocument: null })
      .mockResolvedValueOnce({ ...SENT, xrechnungDocument: null });
    m.ensureZugferdArchive.mockResolvedValue({
      ok: true,
      bucket: 'gobd',
      key: 'pdf-key',
      number: 'R-2026/0001',
    });

    await expectFailure(await request(), 'archive_failed', 502);
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'archive_failed', invoiceId: INVOICE_ID }),
      expect.any(String),
    );
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('gibt eine nach Versand noch ungeteilte Archiv-XML unter dem Lock frei', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(invoice(SENT)).mockResolvedValueOnce({
      ...SENT,
      xrechnungDocument: { ...ARCHIVED_XML, sharedWithClientAt: null },
    });

    expect((await request()).status).toBe(200);
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'xml-doc', sharedWithClientAt: null },
      data: { sharedWithClientAt: expect.any(Date), sharedByStaff: 'staff-1' },
    });
  });

  it('gesperrter Mandant → dieselbe 404-Antwort wie eine unbekannte Rechnung', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(invoice(SENT));
    m.canAccessClientTx.mockResolvedValue(false);

    await expectFailure(await request(), 'not_found', 404);
    expect(m.ensureZugferdArchive).not.toHaveBeenCalled();
  });
});
