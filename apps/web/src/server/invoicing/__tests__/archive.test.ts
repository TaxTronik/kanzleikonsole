import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fachkatalog: INV-ARCHIVE-EINVOICE-001
// Fachkatalog: INV-PORTAL-SHARING-001
// Fachkatalog: INV-STORNO-REFERENCE-001, STBVV-CALCULATION-001
// Fachkatalog: DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001

// IO-Abhängigkeiten mocken (DB/Storage/Generatoren) — wir testen die
// Idempotenz-/Race-/Validierungs-Logik von ensureZugferdArchive, nicht die
// PDF-Erzeugung oder den Object-Store.
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    prepareBytesCommitWithTier: vi.fn(storageJournal.prepare),
    commitPreparedBytes: vi.fn(storageJournal.commit),
    fetchVerifiedObjectBytes: vi.fn(async () => Buffer.from('archived-pdf')),
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (b: unknown) => b }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/actions/staff-action', () => ({ ActionError: class extends Error {} }));
vi.mock('@/server/invoicing/number', () => ({
  allocateInvoiceNumber: vi.fn(async () => '2026-0001'),
}));
vi.mock('@/server/invoicing/xrechnung', () => ({
  generateXRechnungCii: vi.fn(() => '<cii/>'),
  toXRechnungInvoice: vi.fn((invoice: unknown) => invoice),
}));
vi.mock('@/server/invoicing/zugferd', () => ({
  generateZugferdPdf: vi.fn(async () => new Uint8Array([1, 2, 3])),
  extractFacturXXml: vi.fn(async () => Buffer.from('<embedded-cii/>')),
}));
vi.mock('@/server/settings/tenant-settings', () => ({ readSellerInfo: vi.fn() }));
vi.mock('@/server/settings/branding', () => ({
  readBranding: vi.fn(async () => ({ logoDataUrl: null })),
}));
vi.mock('@/server/settings/letterhead', () => ({
  readLetterhead: vi.fn(async () => ({
    organisationName: 'Briefkopf-Kanzlei',
    addressLines: 'Briefkopfweg 1\n10115 Berlin',
    contactLine: 'Telefon +49 30 1',
    footnote: 'Kammerangabe',
  })),
}));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: vi.fn(async () => 'JOURNALED'),
}));

import {
  archiveInputFailure,
  ensureZugferdArchive,
  hasGeneratedEInvoice,
  isCancelledDraft,
  isInvoiceShareable,
  recheckDraftPreview,
  xrechnungBuyer,
} from '../archive';
import { withTenantContext } from '@taxtronik/db';
import { commitPreparedBytes, fetchVerifiedObjectBytes } from '@taxtronik/storage';
import { StoredObjectError } from '@taxtronik/storage/errors';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { extractFacturXXml, generateZugferdPdf } from '@/server/invoicing/zugferd';
import { UnsupportedPdfTextError } from '@/server/documents/pdf-fonts';
import { evidenceService } from '@/server/container';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import { createFeeInvoice, validateFeeCalculation } from '@/server/stbvv/service';
import { STBVV_VERSION } from '@taxtronik/tax';
import { generateXRechnungCii } from '../xrechnung';
import {
  FAKE_RETENTION_UNTIL,
  storageJournal,
} from '@/server/documents/__tests__/storage-journal-fake';

const ctx = { tenantId: 't1', actorId: 's1', actorType: 'STAFF' as const };
const RETENTION_UNTIL = FAKE_RETENTION_UNTIL;
/** Erstes geschriebenes Objekt eines Generierungslaufs ist die ZUGFeRD-PDF. */
const storedPdf = () => {
  const pdf = storageJournal.objects[0]!;
  return {
    bucket: pdf.bucket,
    key: pdf.key,
    storageVersionId: pdf.versionId,
    // R-05: Größe und SHA-256 der gebundenen Fassung für den geprüften Abruf.
    sha256: pdf.sha256,
    sizeBytes: pdf.sizeBytes,
  };
};
/** Archivierte Hybrid-PDF einer Altrechnung (Größe und SHA-256 der Dokumentversion). */
const ARCHIVED_PDF_SHA256 = new Uint8Array(32).fill(0x5a);
const ARCHIVED_PDF_SIZE = 12n;
const openIntent = (source: string) =>
  storageJournal.openIntents().find((intent) => intent.source === source);

const COMPLETE_SELLER = {
  name: 'Kanzlei',
  street: 'Weg 1',
  city: 'Stadt',
  postalCode: '12345',
  email: 'mail@kanzlei.example',
  phone: '+49 30 1',
  vatId: 'DE123456789',
  taxNumber: null,
};
const COMPLETE_CLIENT = {
  name: 'Mandant',
  street: 'Gasse 2',
  city: 'Ort',
  postalCode: '54321',
  countryIso: 'DE',
  vatId: null,
  invoiceEmail: null,
};

const dec = (s: string) => ({ toString: () => s });
function baseInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv1',
    number: 'R-001',
    format: 'XRECHNUNG',
    clientId: 'c1',
    status: 'SENT',
    sentAt: new Date('2026-08-23T12:00:00.000Z'),
    updatedAt: new Date('2026-08-23T12:00:00.000Z'),
    documentId: null,
    xrechnungDocumentId: null,
    issueDate: new Date(),
    dueDate: new Date(),
    subject: 'S',
    notes: null,
    vatRate: dec('19'),
    netAmount: dec('100'),
    vatAmount: dec('19'),
    totalAmount: dec('119'),
    client: COMPLETE_CLIENT,
    positions: [],
    document: null,
    xrechnungDocument: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tx: any;
beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  tx = {
    // Advisory-Lock zur Race-Serialisierung (archive.ts) und atomarer
    // Abschluss der Speicherabsichten (K-06).
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('?').includes('settle_storage_intent')
        ? storageJournal.executeRaw(strings, ...values)
        : 0,
    ),
    invoice: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    document: {
      create: vi.fn().mockImplementation(({ data }: { data: { mimeType: string } }) =>
        Promise.resolve({
          id: data.mimeType === 'application/xml' ? 'xml-doc-new' : 'pdf-doc-new',
        }),
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    documentVersion: { create: vi.fn().mockResolvedValue({}) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(withTenantContext).mockImplementation(((_c: any, cb: any) => cb(tx)) as any);
  vi.mocked(readSellerInfo).mockResolvedValue(COMPLETE_SELLER as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureZugferdArchive', () => {
  it('archiviert einen tatsächlich aus StBVV erzeugten In-App-Entwurf vor der Festschreibung', async () => {
    // Rechnungsjahr muss im laufenden Jahr ± 1 liegen (INV-NUMBER-ALLOCATION-001).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T10:00:00.000Z'));
    const { input, result } = validateFeeCalculation({
      lawVersion: STBVV_VERSION,
      currentLawConfirmed: true,
      matterReviewConfirmed: true,
      lines: [
        {
          id: 'line',
          feeId: '24-1-1',
          matter: 'Erklärung 2026',
          rate: 1,
          rawValue: 10000,
          justification: 'Synthetische geprüfte Testeingabe.',
        },
      ],
      expenses: [],
      vatRate: 19,
    });
    tx.stbvvQuote = {
      findFirst: vi.fn(async () => ({
        id: 'quote',
        title: 'Honorar',
        lawVersion: STBVV_VERSION,
        inputs: input,
        result,
        invoiceExport: null,
      })),
    };
    tx.client = { findFirst: vi.fn(async () => ({ id: 'c1' })) };
    tx.stbvvQuoteExport = { create: vi.fn(async () => ({})) };
    tx.invoice.create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const saved = baseInvoice({
        ...data,
        positions: (data.positions as { create: unknown[] }).create,
        status: 'DRAFT',
        sentAt: null,
      });
      tx.invoice.findFirst.mockResolvedValue(saved);
      return saved;
    });

    const exported = await createFeeInvoice(
      tx,
      't1',
      's1',
      'c1',
      'quote',
      '2026-09-06',
      '2026-09-20',
    );
    expect(exported).toEqual({ invoiceId: 'inv1', existing: false });
    const archive = await ensureZugferdArchive(ctx, exported.invoiceId, { purpose: 'ISSUE' });
    expect(archive).toEqual({ ok: true, ...storedPdf(), number: '2026-0001' });
    expect(generateZugferdPdf).toHaveBeenCalledOnce();
    expect(commitPreparedBytes).toHaveBeenCalledTimes(2);
    // Beide Absichten sind in der Verknuepfungstransaktion abgeschlossen.
    expect(storageJournal.openIntents()).toEqual([]);
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv1' },
      data: { documentId: 'pdf-doc-new', xrechnungDocumentId: 'xml-doc-new' },
    });
  });

  it('belässt ein bereits ausgestelltes Stornoarchiv auch nach dem Wechsel auf BT-3 384 byte-stabil', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(
      baseInvoice({
        stornoOfId: 'original',
        stornoOf: { number: '2026-0041' },
        netAmount: dec('-100'),
        vatAmount: dec('-19'),
        totalAmount: dec('-119'),
        documentId: 'old-381-pdf',
        xrechnungDocumentId: 'old-381-xml',
        document: {
          sharedWithClientAt: new Date(),
          versions: [{ storageBucket: 'gobd', storageKey: 'old-381-pdf-key' }],
        },
        xrechnungDocument: {
          id: 'old-381-xml',
          sharedWithClientAt: new Date(),
          versions: [{ storageBucket: 'gobd', storageKey: 'old-381-xml-key' }],
        },
      }),
    );
    expect(await ensureZugferdArchive(ctx, 'inv1')).toEqual({
      ok: true,
      bucket: 'gobd',
      key: 'old-381-pdf-key',
      number: 'R-001',
    });
    expect(generateXRechnungCii).not.toHaveBeenCalled();
    expect(generateZugferdPdf).not.toHaveBeenCalled();
    expect(commitPreparedBytes).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('idempotent: vorhandenes Archiv → dieselben Bytes, KEINE Neugenerierung', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(
      baseInvoice({
        status: 'SENT',
        documentId: 'doc-existing',
        xrechnungDocumentId: 'xml-existing',
        document: {
          sharedWithClientAt: new Date(),
          versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }],
        },
        xrechnungDocument: {
          id: 'xml-existing',
          sharedWithClientAt: new Date(),
          versions: [{ storageBucket: 'gobd', storageKey: 'xml-existing' }],
        },
      }),
    );
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: true, bucket: 'gobd', key: 'k-existing', number: 'R-001' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
    expect(commitPreparedBytes).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
    // bereits freigegeben → keine erneute Freigabe
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('selbstheilend: als DRAFT erzeugte Kopie wird nach Versand nachträglich freigegeben', async () => {
    // Rechnung ist inzwischen SENT, das verknüpfte Archiv aber noch ungeteilt
    // (z. B. zuvor per DRAFT-Download erzeugt). Der nächste Helfer-Lauf gibt frei.
    tx.invoice.findFirst.mockResolvedValueOnce(
      baseInvoice({
        status: 'SENT',
        documentId: 'doc-existing',
        xrechnungDocumentId: 'xml-existing',
        document: {
          sharedWithClientAt: null,
          versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }],
        },
        xrechnungDocument: {
          id: 'xml-existing',
          sharedWithClientAt: new Date(),
          versions: [{ storageBucket: 'gobd', storageKey: 'xml-existing' }],
        },
      }),
    );
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res.ok).toBe(true);
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-existing', sharedWithClientAt: null },
      data: expect.objectContaining({ sharedByStaff: 's1' }),
    });
  });

  it('rekonstruiert fehlende XML aus der Hybrid-PDF und ignoriert gleichnamige Nicht-XML-Dokumente', async () => {
    const archivedInvoice = baseInvoice({
      status: 'SENT',
      sentAt: new Date(),
      documentId: 'pdf-doc',
      document: {
        sharedWithClientAt: new Date(),
        versions: [
          {
            storageBucket: 'gobd',
            storageKey: 'pdf-key',
            sha256: ARCHIVED_PDF_SHA256,
            sizeBytes: ARCHIVED_PDF_SIZE,
          },
        ],
      },
    });
    tx.invoice.findFirst
      .mockResolvedValueOnce(archivedInvoice)
      .mockResolvedValueOnce(archivedInvoice);
    // Selbst ein gleichnamiges fremdes XML darf nicht als kanonische Kopie
    // gelten. Nur invoice.xrechnungDocumentId ist ein belastbarer Nachweis.
    tx.document.findFirst.mockResolvedValue({
      id: 'unlinked-same-title-xml',
      title: 'Rechnung R-001 (XRechnung)',
      mimeType: 'application/xml',
      versions: [{ storageBucket: 'gobd', storageKey: 'foreign-title-collision' }],
    });

    const result = await ensureZugferdArchive(ctx, 'inv1');

    expect(result).toEqual({
      ok: true,
      bucket: 'gobd',
      key: 'pdf-key',
      sha256: ARCHIVED_PDF_SHA256,
      sizeBytes: ARCHIVED_PDF_SIZE,
      number: 'R-001',
    });
    // R-05: Extraktion nur aus Bytes, die Größe und SHA-256 der Fassung entsprechen.
    expect(fetchVerifiedObjectBytes).toHaveBeenCalledWith(
      { bucket: 'gobd', key: 'pdf-key', versionId: undefined },
      { sizeBytes: ARCHIVED_PDF_SIZE, sha256: ARCHIVED_PDF_SHA256 },
    );
    expect(extractFacturXXml).toHaveBeenCalledWith(Buffer.from('archived-pdf'));
    expect(tx.document.findFirst).not.toHaveBeenCalled();
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mimeType: 'application/xml' }),
      }),
    );
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv1' },
      data: { xrechnungDocumentId: 'xml-doc-new' },
    });
  });

  it('teilt eine nachträglich materialisierte XML auch bei bereits versendetem Storno', async () => {
    const cancelledAfterSend = baseInvoice({
      status: 'CANCELLED',
      sentAt: new Date('2026-08-01T10:00:00.000Z'),
      documentId: 'pdf-doc',
      document: {
        sharedWithClientAt: new Date(),
        versions: [{ storageBucket: 'gobd', storageKey: 'pdf-key' }],
      },
    });
    tx.invoice.findFirst
      .mockResolvedValueOnce(cancelledAfterSend)
      .mockResolvedValueOnce(cancelledAfterSend);

    const result = await ensureZugferdArchive(ctx, 'inv1');

    expect(result.ok).toBe(true);
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: 'application/xml',
          sharedWithClientAt: expect.any(Date),
          sharedByStaff: 's1',
        }),
      }),
    );
  });

  it('R-05: rekonstruiert keine XML aus PDF-Bytes, die von der archivierten Fassung abweichen', async () => {
    const archivedInvoice = baseInvoice({
      status: 'SENT',
      sentAt: new Date(),
      documentId: 'pdf-doc',
      document: {
        sharedWithClientAt: new Date(),
        versions: [
          {
            storageBucket: 'gobd',
            storageKey: 'pdf-key',
            sha256: ARCHIVED_PDF_SHA256,
            sizeBytes: ARCHIVED_PDF_SIZE,
          },
        ],
      },
    });
    tx.invoice.findFirst.mockResolvedValue(archivedInvoice);
    vi.mocked(fetchVerifiedObjectBytes).mockRejectedValueOnce(
      new StoredObjectError('HASH_MISMATCH', 'SHA-256 weicht von der Fassung ab.'),
    );

    await expect(ensureZugferdArchive(ctx, 'inv1')).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'HASH_MISMATCH',
    });
    expect(extractFacturXXml).not.toHaveBeenCalled();
    expect(storageJournal.rows).toEqual([]);
    expect(storageJournal.objects).toEqual([]);
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it('DRAFT-Kontrollvorschau rendert frisch und verändert vorhandene Archive nicht', async () => {
    const draft = baseInvoice({
      status: 'DRAFT',
      sentAt: null,
      documentId: 'doc-existing',
      document: {
        sharedWithClientAt: null,
        versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }],
      },
    });
    tx.invoice.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(draft);
    const result = await ensureZugferdArchive(ctx, 'inv1', { purpose: 'PREVIEW' });

    expect(result).toEqual({ ok: true, bytes: Buffer.from([1, 2, 3]), number: 'R-001' });
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(commitPreparedBytes).not.toHaveBeenCalled();
  });

  it('liefert nach einem parallelen DRAFT→SENT während des Renderns nur kanonische Archivbytes', async () => {
    const draft = baseInvoice({ status: 'DRAFT', sentAt: null, documentId: null });
    const issued = baseInvoice({
      status: 'SENT',
      sentAt: new Date('2026-08-23T12:01:00.000Z'),
      updatedAt: new Date('2026-08-23T12:01:00.000Z'),
      documentId: 'pdf-issued',
      xrechnungDocumentId: 'xml-issued',
      document: {
        sharedWithClientAt: new Date(),
        versions: [{ storageBucket: 'gobd', storageKey: 'pdf-issued-key' }],
      },
      xrechnungDocument: {
        id: 'xml-issued',
        sharedWithClientAt: new Date(),
        versions: [{ storageBucket: 'gobd', storageKey: 'xml-issued-key' }],
      },
    });
    tx.invoice.findFirst
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(issued)
      .mockResolvedValueOnce(issued);

    const result = await ensureZugferdArchive(ctx, 'inv1', { purpose: 'PREVIEW' });

    expect(result).toEqual({
      ok: true,
      bucket: 'gobd',
      key: 'pdf-issued-key',
      number: 'R-001',
    });
    expect(generateZugferdPdf).toHaveBeenCalledTimes(1);
    expect(commitPreparedBytes).not.toHaveBeenCalled();
  });

  it('verwendet nach parallelem Draft-Refresh keinen vor dem Lock geladenen Archivpointer', async () => {
    const stale = baseInvoice({
      status: 'DRAFT',
      sentAt: null,
      documentId: 'stale-draft-pdf',
      document: {
        sharedWithClientAt: null,
        versions: [{ storageBucket: 'gobd', storageKey: 'stale-draft-key' }],
      },
    });
    const refreshed = baseInvoice({ status: 'DRAFT', sentAt: null });
    tx.invoice.findFirst
      .mockResolvedValueOnce(stale)
      // Ein anderer ISSUE-Aufruf hat das alte Draft-Archiv bereits geloest.
      .mockResolvedValueOnce(refreshed)
      // Finale Verknuepfung sieht weiterhin einen archivlosen Entwurf.
      .mockResolvedValueOnce(refreshed);
    tx.document.findFirst.mockResolvedValue(null);

    const result = await ensureZugferdArchive(ctx, 'inv1', { purpose: 'ISSUE' });

    expect(result).toEqual({ ok: true, ...storedPdf(), number: 'R-001' });
    expect(generateZugferdPdf).toHaveBeenCalledTimes(1);
    expect(fetchVerifiedObjectBytes).not.toHaveBeenCalled();
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv1' },
      data: { documentId: 'pdf-doc-new', xrechnungDocumentId: 'xml-doc-new' },
    });
  });

  it('Lazy-XML wird nicht nach einem parallel gewonnenen Entwurfsstorno verknüpft', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(
        baseInvoice({
          status: 'DRAFT',
          sentAt: null,
          documentId: 'doc-existing',
          document: {
            sharedWithClientAt: null,
            versions: [{ storageBucket: 'gobd', storageKey: 'k-existing' }],
          },
        }),
      )
      .mockResolvedValueOnce(baseInvoice({ status: 'CANCELLED', sentAt: null, documentId: null }));

    const res = await ensureZugferdArchive(ctx, 'inv1');

    expect(res).toEqual({ ok: false, code: 'status_conflict' });
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(commitPreparedBytes).not.toHaveBeenCalled();
  });

  it('not_applicable für EXTERNAL/PDF-Rechnung (deren documentId ist der Upload)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(
      baseInvoice({
        format: 'PDF',
        documentId: 'upload',
        document: { versions: [{ storageBucket: 'b', storageKey: 'k' }] },
      }),
    );
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'not_applicable' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
  });

  it('seller_incomplete bei unvollständigen Verkäuferdaten', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(readSellerInfo).mockResolvedValue({
      name: 'X',
      street: '',
      city: '',
      postalCode: '',
    } as never);
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
    vi.mocked(readSellerInfo).mockResolvedValue({
      ...COMPLETE_SELLER,
      vatId: null,
      taxNumber: null,
    } as never);
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'seller_incomplete' });
    expect(generateZugferdPdf).not.toHaveBeenCalled();
  });

  it('Steuernummer allein genügt (USt-ID fehlt, taxNumber gesetzt)', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice({ status: 'SENT' }))
      .mockResolvedValueOnce(baseInvoice({ status: 'SENT' }));
    vi.mocked(readSellerInfo).mockResolvedValue({
      ...COMPLETE_SELLER,
      vatId: null,
      taxNumber: '12/345/67890',
    } as never);
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res.ok).toBe(true);
  });

  it('buyer_incomplete bei unvollständiger Mandantenadresse', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(
      baseInvoice({ client: { ...COMPLETE_CLIENT, street: null } }),
    );
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: false, code: 'buyer_incomplete' });
  });

  it.each(['ISSUE', 'PREVIEW'] as const)(
    'reverse_charge_seller_no_vatid (%s): Reverse-Charge verlangt die USt-IdNr der Kanzlei (BR-AE-01)',
    async (purpose) => {
      // ISSUE liest den Entwurf unter dem Lock erneut (Draft-Refresh).
      tx.invoice.findFirst.mockResolvedValue(
        baseInvoice({ status: 'DRAFT', sentAt: null, reverseCharge: true }),
      );
      vi.mocked(readSellerInfo).mockResolvedValue({
        ...COMPLETE_SELLER,
        vatId: null,
        taxNumber: '12/345/67890',
      } as never);

      const res = await ensureZugferdArchive(ctx, 'inv1', { purpose });

      expect(res).toEqual({ ok: false, code: 'reverse_charge_seller_no_vatid' });
      expect(generateZugferdPdf).not.toHaveBeenCalled();
      expect(commitPreparedBytes).not.toHaveBeenCalled();
    },
  );

  it('generiert + speichert + verknüpft, wenn kein Archiv existiert', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice()) // load: kein documentId
      .mockResolvedValueOnce(baseInvoice()); // write-tx Re-Check: immer noch keins
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: true, ...storedPdf(), number: 'R-001' });
    expect(generateZugferdPdf).toHaveBeenCalledTimes(1);
    expect(generateZugferdPdf).toHaveBeenCalledWith(
      expect.anything(),
      COMPLETE_SELLER,
      expect.anything(),
      '<cii/>',
      expect.objectContaining({
        logoDataUrl: null,
        letterhead: expect.objectContaining({ organisationName: 'Briefkopf-Kanzlei' }),
      }),
    );
    expect(commitPreparedBytes).toHaveBeenCalledTimes(2);
    // K-06: Beide Absichten standen vor dem ersten PUT im Journal und wurden
    // in der Verknuepfungstransaktion abgeschlossen.
    expect(storageJournal.events.slice(0, 3)).toEqual(['prepare', 'prepare', 'journal']);
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({ source: 'invoice.archive.zugferd_pdf', resolution: 'REFERENCED' }),
      expect.objectContaining({
        source: 'invoice.archive.xrechnung_xml',
        resolution: 'REFERENCED',
      }),
    ]);
    expect(tx.document.create).toHaveBeenCalledTimes(2);
    expect(tx.document.create.mock.calls[0]![0]!.data.retentionUntil).toEqual(RETENTION_UNTIL);
    expect(tx.document.create.mock.calls[1]![0]!.data.retentionUntil).toEqual(RETENTION_UNTIL);
    expect(tx.documentVersion.create).toHaveBeenCalledTimes(2);
    // DOC-UPLOAD-JOURNAL-001: Generierte PDF-/XML-Ausgaben erfüllen ebenfalls
    // den allgemeinen Download-Gate; keine Klassifikationsausnahme nötig.
    for (const [call] of tx.documentVersion.create.mock.calls) {
      expect(call.data).toMatchObject({ scanStatus: 'CLEAN', scanCompletedAt: expect.any(Date) });
    }
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv1' },
      data: { documentId: 'pdf-doc-new', xrechnungDocumentId: 'xml-doc-new' },
    });
    expect(evidenceService.record).toHaveBeenCalledTimes(1);
  });

  it('DRAFT-Archiv wird NICHT fürs Portal freigegeben (sharedWithClientAt=null)', async () => {
    // Beim tatsächlichen Versand entsteht die Archivkopie noch vor dem
    // DRAFT→SENT-Claim und darf bis zu dessen Erfolg nicht im Portal stehen.
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice({ status: 'DRAFT', sentAt: null }))
      .mockResolvedValueOnce(baseInvoice({ status: 'DRAFT', sentAt: null }))
      .mockResolvedValueOnce(baseInvoice({ status: 'DRAFT', sentAt: null }));
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
      .mockResolvedValueOnce(
        baseInvoice({
          // write-tx Re-Check: jetzt verknüpft
          documentId: 'doc-winner',
          xrechnungDocumentId: 'xml-winner',
          document: { versions: [{ storageBucket: 'gobd', storageKey: 'k-winner' }] },
          xrechnungDocument: {
            id: 'xml-winner',
            sharedWithClientAt: new Date(),
            versions: [{ storageBucket: 'gobd', storageKey: 'xml-winner-key' }],
          },
        }),
      );
    const res = await ensureZugferdArchive(ctx, 'inv1');
    expect(res).toEqual({ ok: true, bucket: 'gobd', key: 'k-winner', number: 'R-001' });
    // Generierung lief (vor dem Re-Check), aber es entsteht KEIN zweites Document.
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    // K-06: Die nicht uebernommenen Objekte bleiben als offene Absichten mit
    // gebundener Version fuer den Cleanup-Worker (Object Lock: nach Retention).
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(openIntent('invoice.archive.zugferd_pdf')).toMatchObject({
      failure: expect.stringContaining('invoice.archive.zugferd_race'),
      storageVersionId: storageJournal.objects[0]!.versionId,
    });
    expect(openIntent('invoice.archive.xrechnung_xml')).toMatchObject({
      failure: expect.stringContaining('invoice.archive.xrechnung_race'),
      storageVersionId: storageJournal.objects[1]!.versionId,
    });
  });

  it('materialisiert nach einem PDF-only Race-Gewinner XML exakt aus dessen Hybrid-PDF', async () => {
    const winner = baseInvoice({
      documentId: 'doc-winner',
      document: { versions: [{ storageBucket: 'gobd', storageKey: 'k-winner' }] },
    });
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice())
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(winner);

    const result = await ensureZugferdArchive(ctx, 'inv1');

    expect(result).toEqual({ ok: true, bucket: 'gobd', key: 'k-winner', number: 'R-001' });
    expect(fetchVerifiedObjectBytes).toHaveBeenCalledWith(
      { bucket: 'gobd', key: 'k-winner', versionId: undefined },
      { sizeBytes: undefined, sha256: undefined },
    );
    expect(extractFacturXXml).toHaveBeenCalledWith(Buffer.from('archived-pdf'));
    expect(tx.document.create).toHaveBeenCalledTimes(1);
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mimeType: 'application/xml' }) }),
    );
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'inv1' },
      data: { xrechnungDocumentId: 'xml-doc-new' },
    });
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(openIntent('invoice.archive.zugferd_pdf')?.failure).toContain(
      'invoice.archive.zugferd_race',
    );
    expect(openIntent('invoice.archive.xrechnung_xml')?.failure).toContain(
      'invoice.archive.xrechnung_race',
    );
    // Die aus der Gewinner-PDF extrahierte XML wurde abgeschlossen.
    expect(storageJournal.rows).toContainEqual(
      expect.objectContaining({
        source: 'invoice.archive.lazy_xrechnung',
        resolution: 'REFERENCED',
      }),
    );
  });

  it('Race: ein Entwurfsstorno gewinnt vor der Archivverknüpfung', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice({ status: 'DRAFT', sentAt: null }))
      .mockResolvedValueOnce(baseInvoice({ status: 'CANCELLED', sentAt: null }));

    const res = await ensureZugferdArchive(ctx, 'inv1');

    expect(res).toEqual({ ok: false, code: 'status_conflict' });
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(storageJournal.events).toEqual([]);
  });

  it('haelt beide Absichten offen, wenn die Rechnung vor der Verknuepfung storniert wird', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(baseInvoice()) // load: SENT, kein Archiv
      .mockResolvedValueOnce(baseInvoice({ status: 'CANCELLED', sentAt: null }));

    const res = await ensureZugferdArchive(ctx, 'inv1');

    expect(res).toEqual({ ok: false, code: 'status_conflict' });
    expect(tx.document.create).not.toHaveBeenCalled();
    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(storageJournal.openIntents().map((intent) => intent.failure)).toEqual([
      expect.stringContaining('invoice.archive.zugferd_unlinked'),
      expect.stringContaining('invoice.archive.xrechnung_unlinked'),
    ]);
  });

  it('haelt die bereits gespeicherte PDF offen, wenn der XML-Storage-Commit scheitert', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(commitPreparedBytes)
      .mockImplementationOnce(storageJournal.commit)
      .mockRejectedValueOnce(new Error('xml storage unavailable'));

    await expect(ensureZugferdArchive(ctx, 'inv1')).rejects.toThrow('XRechnung-Ablage');

    expect(compensateStorageCommit).not.toHaveBeenCalled();
    expect(openIntent('invoice.archive.zugferd_pdf')).toMatchObject({
      tenantId: 't1',
      storageVersionId: storageJournal.objects[0]!.versionId,
      failure: 'xml storage unavailable',
      immutable: true,
    });
    // Die XML-Absicht ohne Objekt schliesst der Worker spaeter als ABSENT ab.
    expect(openIntent('invoice.archive.xrechnung_xml')).toMatchObject({
      storageVersionId: '',
      failure: 'xml storage unavailable',
    });
  });

  // C5: Nicht darstellbare Zeichen erreichen Versand, Storno und Downloadrouten
  // unverpackt (Meldung mit Zeichen und Feld); es wird nichts abgelegt.
  it.each([
    ['Ausstellung', 'ISSUE', baseInvoice()],
    ['Kontrollvorschau', 'PREVIEW', baseInvoice({ status: 'DRAFT', sentAt: null })],
  ] as const)(
    'reicht nicht darstellbare Zeichen bei der %s unverpackt durch',
    async (_name, purpose, invoice) => {
      const rejected = new UnsupportedPdfTextError([0x674e]);
      tx.invoice.findFirst.mockResolvedValue(invoice);
      vi.mocked(generateZugferdPdf).mockRejectedValueOnce(rejected);

      await expect(ensureZugferdArchive(ctx, 'inv1', { purpose })).rejects.toBe(rejected);
      expect(commitPreparedBytes).not.toHaveBeenCalled();
      expect(storageJournal.rows).toEqual([]);
    },
  );

  it('verpackt technische Erzeugungsfehler weiterhin mit Schrittkontext', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(generateZugferdPdf).mockRejectedValueOnce(new Error('font missing'));

    await expect(ensureZugferdArchive(ctx, 'inv1')).rejects.toThrow(
      'ZUGFeRD-PDF-Generierung fehlgeschlagen: font missing',
    );
    expect(commitPreparedBytes).not.toHaveBeenCalled();
  });

  // K-06: Prozessabbruch zwischen Object-Write und Verknuepfung (erzeugte Archive).
  it('hinterlaesst nach einem Abbruch vor der Verknuepfung zwei aufloesbare Absichten', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    vi.mocked(withTenantContext)
      .mockImplementationOnce(((_c: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never)
      .mockImplementationOnce((() => new Promise(() => undefined)) as never);

    void ensureZugferdArchive(ctx, 'inv1');
    await vi.waitFor(() => expect(storageJournal.objects).toHaveLength(2));

    const intents = storageJournal.openIntents();
    expect(intents.map((intent) => intent.source)).toEqual([
      'invoice.archive.zugferd_pdf',
      'invoice.archive.xrechnung_xml',
    ]);
    for (const intent of intents) {
      expect(storageJournal.workerContract(intent)).toEqual({
        selectable: true,
        tenantPrefix: true,
        objectVersions: 1,
        retentionGated: true,
      });
    }
  });
});

describe('recheckDraftPreview (gemeinsamer Recheck der XML- und PDF-Vorschau)', () => {
  const snapshot = {
    updatedAt: new Date('2026-08-23T12:00:00.000Z'),
    documentId: null,
    xrechnungDocumentId: null,
  };
  const draft = (overrides: Record<string, unknown> = {}) =>
    baseInvoice({ status: 'DRAFT', sentAt: null, ...overrides });

  it('preview, solange der Entwurf unverändert ist (unter dem Archiv-Lock)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(draft());
    await expect(recheckDraftPreview(ctx, 'inv1', snapshot)).resolves.toEqual({
      state: 'preview',
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('status_conflict bei geändertem oder storniertem Entwurf', async () => {
    tx.invoice.findFirst
      .mockResolvedValueOnce(draft({ updatedAt: new Date('2026-08-23T12:00:01.000Z') }))
      .mockResolvedValueOnce(draft({ status: 'CANCELLED' }));
    await expect(recheckDraftPreview(ctx, 'inv1', snapshot)).resolves.toEqual({
      state: 'status_conflict',
    });
    await expect(recheckDraftPreview(ctx, 'inv1', snapshot)).resolves.toEqual({
      state: 'status_conflict',
    });
  });

  it('not_found, wenn die Rechnung verschwunden ist', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(null);
    await expect(recheckDraftPreview(ctx, 'inv1', snapshot)).resolves.toEqual({
      state: 'not_found',
    });
  });

  it('issued mit Archiv-PDF, wenn die Ausstellung das Rendern überholt hat', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(
      baseInvoice({
        documentId: 'pdf-doc',
        xrechnungDocumentId: 'xml-doc',
        document: {
          versions: [{ storageBucket: 'gobd', storageKey: 'pdf-key', storageVersionId: 'v1' }],
        },
      }),
    );
    await expect(recheckDraftPreview(ctx, 'inv1', snapshot)).resolves.toEqual({
      state: 'issued',
      pdf: { bucket: 'gobd', key: 'pdf-key', storageVersionId: 'v1' },
    });
  });

  it('issued ohne Archiv für eine ausgestellte Rechnung ohne verknüpfte PDF', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(baseInvoice());
    await expect(recheckDraftPreview(ctx, 'inv1', snapshot)).resolves.toEqual({
      state: 'issued',
      pdf: null,
    });
  });

  it('erkennt auch einen geänderten XML-Zeiger als überholten Snapshot', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(
      draft({
        documentId: 'pdf-doc',
        xrechnungDocumentId: 'xml-doc',
        document: { versions: [{ storageBucket: 'gobd', storageKey: 'pdf-key' }] },
      }),
    );
    const rechecked = await recheckDraftPreview(ctx, 'inv1', {
      ...snapshot,
      documentId: 'pdf-doc',
    });
    expect(rechecked).toEqual({
      state: 'issued',
      pdf: { bucket: 'gobd', key: 'pdf-key', storageVersionId: undefined },
    });
  });

  it('erzeugt für einen Entwurf mit gelöstem Archivzeiger kein Archiv (status_conflict)', async () => {
    tx.invoice.findFirst.mockResolvedValueOnce(draft());
    await expect(
      recheckDraftPreview(ctx, 'inv1', { ...snapshot, documentId: 'stale-draft-pdf' }),
    ).resolves.toEqual({ state: 'status_conflict' });
  });
});

describe('gemeinsame Prüfungen und Käufer-Mapping', () => {
  it('xrechnungBuyer bildet die Mandantendaten ab (Land default DE)', () => {
    expect(xrechnungBuyer({ ...COMPLETE_CLIENT, countryIso: null, vatId: 'DE1' })).toEqual({
      name: 'Mandant',
      street: 'Gasse 2',
      postalCode: '54321',
      city: 'Ort',
      countryIso: 'DE',
      vatId: 'DE1',
      email: null,
    });
  });

  it('archiveInputFailure prüft Verkäufer vor Reverse-Charge vor Käufer', () => {
    const rc = { reverseCharge: true, client: { ...COMPLETE_CLIENT, city: null } };
    expect(archiveInputFailure(rc, { ...COMPLETE_SELLER, phone: null } as never)).toBe(
      'seller_incomplete',
    );
    expect(
      archiveInputFailure(rc, { ...COMPLETE_SELLER, vatId: null, taxNumber: '1' } as never),
    ).toBe('reverse_charge_seller_no_vatid');
    expect(archiveInputFailure(rc, COMPLETE_SELLER as never)).toBe('buyer_incomplete');
    expect(
      archiveInputFailure({ ...rc, client: COMPLETE_CLIENT }, COMPLETE_SELLER as never),
    ).toBeNull();
  });

  it('Freigabe- und Entwurfsprüfung', () => {
    const sentAt = new Date();
    expect(isInvoiceShareable({ status: 'DRAFT', sentAt: null })).toBe(false);
    expect(isInvoiceShareable({ status: 'CANCELLED', sentAt: null })).toBe(false);
    expect(isInvoiceShareable({ status: 'CANCELLED', sentAt })).toBe(true);
    expect(isInvoiceShareable({ status: 'PAID', sentAt: null })).toBe(true);
    expect(isCancelledDraft({ status: 'CANCELLED', sentAt: null })).toBe(true);
    expect(isCancelledDraft({ status: 'CANCELLED', sentAt })).toBe(false);
    expect(isCancelledDraft({ status: 'DRAFT', sentAt: null })).toBe(false);
    expect(hasGeneratedEInvoice({ format: 'PDF' })).toBe(false);
    expect(hasGeneratedEInvoice({ format: 'XRECHNUNG' })).toBe(true);
  });
});
