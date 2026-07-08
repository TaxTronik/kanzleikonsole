import { describe, it, expect, vi, beforeEach } from 'vitest';

// IO-Abhängigkeiten mocken (DB/Storage/Generatoren) — wir testen die
// Idempotenz-/Race-/Validierungs-Logik von ensureZugferdArchive, nicht die
// PDF-Erzeugung oder den Object-Store.
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({ commitBytesWithTier: vi.fn() }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (b: unknown) => b }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/invoicing/xrechnung', () => ({ generateXRechnungCii: vi.fn(() => '<cii/>') }));
vi.mock('@/server/invoicing/zugferd', () => ({ generateZugferdPdf: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock('@/server/settings/tenant-settings', () => ({ readSellerInfo: vi.fn() }));
vi.mock('@/server/settings/branding', () => ({ readBranding: vi.fn(async () => ({ logoDataUrl: null })) }));

import { ensureZugferdArchive } from '../archive';
import { withTenantContext } from '@taxtronik/db';
import { commitBytesWithTier } from '@taxtronik/storage';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { generateZugferdPdf } from '@/server/invoicing/zugferd';
import { evidenceService } from '@/server/container';

const ctx = { tenantId: 't1', actorId: 's1', actorType: 'STAFF' as const };

const COMPLETE_SELLER = {
  name: 'Kanzlei', street: 'Weg 1', city: 'Stadt', postalCode: '12345',
  email: 'mail@kanzlei.example', phone: '+49 30 1', vatId: 'DE123456789', taxNumber: null,
};
const COMPLETE_CLIENT = {
  name: 'Mandant', street: 'Gasse 2', city: 'Ort', postalCode: '54321',
  countryIso: 'DE', vatId: null, invoiceEmail: null,
};

const dec = (s: string) => ({ toString: () => s });
function baseInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv1', number: 'R-001', format: 'XRECHNUNG', clientId: 'c1', documentId: null,
    issueDate: new Date(), dueDate: new Date(), subject: 'S', notes: null,
    vatRate: dec('19'), netAmount: dec('100'), vatAmount: dec('19'), totalAmount: dec('119'),
    client: COMPLETE_CLIENT, positions: [], document: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tx: any;
beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    // Advisory-Lock zur Race-Serialisierung (archive.ts).
    $executeRaw: vi.fn().mockResolvedValue(0),
    invoice: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    document: {
      create: vi.fn().mockResolvedValue({ id: 'doc1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    documentVersion: { create: vi.fn().mockResolvedValue({}) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(withTenantContext).mockImplementation(((_c: any, cb: any) => cb(tx)) as any);
  vi.mocked(readSellerInfo).mockResolvedValue(COMPLETE_SELLER as never);
  vi.mocked(commitBytesWithTier).mockResolvedValue({
    targetBucket: 'gobd', targetKey: 'k-new', sha256: Buffer.from([9]), sizeBytes: 3, immutable: true,
  } as never);
});

describe('ensureZugferdArchive', () => {
  it('idempotent: vorhandenes Archiv → dieselben Bytes, KEINE Neugenerierung', async () => {
    tx.document.findFirst.mockResolvedValueOnce({
      id: 'xml-existing',
      sharedWithClientAt: new Date(),
      versions: [{ storageBucket: 'gobd', storageKey: 'xml-existing' }],
    });
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice({
      status: 'SENT',
      documentId: 'doc-existing',
      document: { sharedWithClientAt: new Date(), versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }] },
    }));
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: true, bucket: 'gobd', key: 'k-existing', number: 'R-001' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
    expect(commitBytesWithTier).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
    // bereits freigegeben → keine erneute Freigabe
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('selbstheilend: als DRAFT erzeugte Kopie wird nach Versand nachträglich freigegeben', async () => {
    tx.document.findFirst.mockResolvedValueOnce({
      id: 'xml-existing',
      sharedWithClientAt: new Date(),
      versions: [{ storageBucket: 'gobd', storageKey: 'xml-existing' }],
    });
    // Rechnung ist inzwischen SENT, das verknüpfte Archiv aber noch ungeteilt
    // (z. B. zuvor per DRAFT-Download erzeugt). Der nächste Helfer-Lauf gibt frei.
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice({
      status: 'SENT',
      documentId: 'doc-existing',
      document: { sharedWithClientAt: null, versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }] },
    }));
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res.ok).toBe(true);
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-existing', sharedWithClientAt: null },
      data: expect.objectContaining({ sharedByStaff: 's1' }),
    });
  });

  it('DRAFT mit verknüpfter Kopie wird NICHT nachträglich freigegeben', async () => {
    tx.document.findFirst.mockResolvedValueOnce({
      id: 'xml-existing',
      sharedWithClientAt: null,
      versions: [{ storageBucket: 'gobd', storageKey: 'xml-existing' }],
    });
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice({
      status: 'DRAFT',
      documentId: 'doc-existing',
      document: { sharedWithClientAt: null, versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }] },
    }));
    await ensureZugferdArchive(ctx, 'inv1');
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('not_applicable für EXTERNAL/PDF-Rechnung (deren documentId ist der Upload)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice({
      format: 'PDF', documentId: 'upload',
      document: { versions: [{ storageBucket: 'b', storageKey: 'k' }] },
    }));
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'not_applicable' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
  });

  it('seller_incomplete bei unvollständigen Verkäuferdaten', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(readSellerInfo).mockResolvedValue({ name: 'X', street: '', city: '', postalCode: '' } as never);
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'seller_incomplete' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
  });

  it('seller_incomplete ohne Telefon/E-Mail (BG-6-Pflicht der XRechnung)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(readSellerInfo).mockResolvedValue({ ...COMPLETE_SELLER, phone: null } as never);
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'seller_incomplete' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
  });

  it('seller_incomplete ohne USt-ID UND Steuernummer (BR-S-02)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(readSellerInfo).mockResolvedValue({ ...COMPLETE_SELLER, vatId: null, taxNumber: null } as never);
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'seller_incomplete' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
  });

  it('Steuernummer allein genügt (USt-ID fehlt, taxNumber gesetzt)', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice({ status: 'SENT' }))
      .mockResolvedValueOnce(baseInvoice({ status: 'SENT' }));
    vi.mocked(readSellerInfo).mockResolvedValue({ ...COMPLETE_SELLER, vatId: null, taxNumber: '12/345/67890' } as never);
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res.ok).toBe(true);
  });

  it('buyer_incomplete bei unvollständiger Mandantenadresse', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice({ client: { ...COMPLETE_CLIENT, street: null } }));
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'buyer_incomplete' });
  });

  it('generiert + speichert + verknüpft, wenn kein Archiv existiert', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice()) // load: kein documentId
      .mockResolvedValueOnce(baseInvoice()); // write-tx Re-Check: immer noch keins
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: true, bucket: 'gobd', key: 'k-new', number: 'R-001' });
    expect(generateZugferdPdf).toHaveBeenCalledTimes(1);
    expect(commitBytesWithTier).toHaveBeenCalledTimes(2);
    expect(tx.document.create).toHaveBeenCalledTimes(2);
    expect(tx.documentVersion.create).toHaveBeenCalledTimes(2);
    expect(tx.invoice.update).toHaveBeenCalledWith({ where: { id: 'inv1' }, data: { documentId: 'doc1' } });
    expect(evidenceService.record).toHaveBeenCalledTimes(1);
  });

  it('DRAFT-Archiv wird NICHT fürs Portal freigegeben (sharedWithClientAt=null)', async () => {
    // Review-Fix: ein Kontroll-Download des ZUGFeRD eines Entwurfs erzeugt die
    // Archivkopie, darf sie aber nicht im Mandanten-Portal sichtbar machen.
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice({ status: 'DRAFT' }))
      .mockResolvedValueOnce(baseInvoice({ status: 'DRAFT' }));
    await ensureZugferdArchive(ctx, 'inv1');
    const created = tx.document.create.mock.calls[0]![0]!.data;
    expect(created.sharedWithClientAt).toBeNull();
    expect(created.sharedByStaff).toBeNull();
  });

  it('Lazy-Archiv einer bereits versendeten Rechnung wird freigegeben', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice({ status: 'SENT' }))
      .mockResolvedValueOnce(baseInvoice({ status: 'SENT' }));
    await ensureZugferdArchive(ctx, 'inv1');
    const created = tx.document.create.mock.calls[0]![0]!.data;
    expect(created.sharedWithClientAt).toBeInstanceOf(Date);
    expect(created.sharedByStaff).toBe('s1');
  });

  it('Race: paralleler Aufruf hat inzwischen verknüpft → KEIN Duplikat, Gewinner-Bytes', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice()) // load: kein documentId
      .mockResolvedValueOnce(baseInvoice({ // write-tx Re-Check: jetzt verknüpft
        documentId: 'doc-winner',
        document: { versions: [{ storageBucket: 'gobd', storageKey: 'k-winner' }] },
      }));
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: true, bucket: 'gobd', key: 'k-winner', number: 'R-001' });
    // Generierung lief (vor dem Re-Check), aber es entsteht KEIN zweites Document.
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});
