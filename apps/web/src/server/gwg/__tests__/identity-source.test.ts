// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-SELF-ONBOARDING-001
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { PDFDocument } from 'pdf-lib';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
// R-05: S3 am Storage-Client mocken, damit der echte, immer prüfende Leseweg
// (fetchVerifiedObjectBytes) mitläuft. `mocks.fetch` liefert die Objektbytes.
vi.mock('@taxtronik/storage/client', async (importOriginal) => {
  const { Readable } = await import('node:stream');
  return {
    ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
    s3: {
      send: async () => {
        const body = (await mocks.fetch()) as Buffer;
        return { Body: Readable.from([body]), ContentLength: body.length };
      },
    },
  };
});
import {
  IdentitySourceStorageError,
  identityViewsNeedPageCheck,
  loadIdentitySourcesForPageCheckTx,
  loadIdentitySourceTx,
  NO_IDENTITY_PDF_PAGE_COUNTS,
  prepareIdentityPdfPageCounts,
  readIdentitySourceBytes,
  validateIdentityViewportsTx,
  type IdentitySource,
} from '../identity-source';

const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('original-identification-evidence');
function documentFixture() {
  return {
    id: 'document',
    title: 'Ausweis',
    mimeType: 'image/png',
    versions: [
      {
        id: VERSION_ID,
        storageBucket: 'evidence',
        storageKey: 'tenant/client/document/version',
        storageVersionId: 's3-version',
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        sha256: createHash('sha256').update(bytes).digest(),
        sizeBytes: BigInt(bytes.length),
        pdfPageCount: null as number | null,
      },
    ],
  };
}
function transaction(doc: ReturnType<typeof documentFixture> | null = documentFixture()) {
  const findFirst = vi.fn().mockResolvedValue(doc);
  return { tx: { document: { findFirst } } as unknown as TxClient, findFirst };
}
const input = { tenantId: 'tenant', clientId: 'client', documentId: 'document' };
const view = {
  side: 'front' as const,
  versionId: VERSION_ID,
  page: 1,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0 as const,
};
const crop = { ...view, width: 0.5 };
async function pdfWithPages(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) pdf.addPage();
  return Buffer.from(await pdf.save());
}
function pdfDocumentFixture(pdfBytes: Buffer) {
  const doc = documentFixture();
  doc.mimeType = 'application/pdf';
  doc.versions[0]!.sha256 = createHash('sha256').update(pdfBytes).digest();
  doc.versions[0]!.sizeBytes = BigInt(pdfBytes.length);
  return doc;
}
async function sourceOf(doc: ReturnType<typeof documentFixture>): Promise<IdentitySource> {
  return (await loadIdentitySourceTx(transaction(doc).tx, input))!;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(bytes);
});

describe('GWG-IDENTIFICATION-EVIDENCE-001 / GWG-SELF-ONBOARDING-001: source version binding', () => {
  it('scopes lookup to tenant/client and available GwG evidence, selecting the newest version', async () => {
    const { tx, findFirst } = transaction();
    expect(await loadIdentitySourceTx(tx, input)).toMatchObject({
      documentId: 'document',
      version: { id: VERSION_ID },
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'document',
        tenantId: 'tenant',
        clientId: 'client',
        classification: 'GWG_EVIDENCE',
        deletedAt: null,
        gwgDestroyedAt: null,
        gwgDestructionRequestedAt: null,
      },
      select: expect.objectContaining({
        versions: expect.objectContaining({ orderBy: { versionNo: 'desc' }, take: 1 }),
      }),
    });
  });
  it('does not read bytes when a foreign, deleted or unavailable document is absent in the scoped query', async () => {
    const { tx } = transaction(null);
    expect(await loadIdentitySourceTx(tx, input)).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { scanStatus: 'PENDING' },
    { scanStatus: 'INFECTED' },
    { scanCompletedAt: null },
    { storageVersionId: null },
    { sizeBytes: 25n * 1024n * 1024n + 1n },
  ])('rejects an unsafe/unbound source: %o', async (override) => {
    const doc = documentFixture();
    Object.assign(doc.versions[0]!, override);
    expect(await loadIdentitySourceTx(transaction(doc).tx, input)).toBeNull();
  });
  it('checks digest and length before returning downloaded bytes', async () => {
    const source = (await loadIdentitySourceTx(transaction().tx, input))!;
    expect(await readIdentitySourceBytes(source)).toEqual(bytes);
    mocks.fetch.mockResolvedValueOnce(Buffer.alloc(bytes.length, 0));
    await expect(readIdentitySourceBytes(source)).rejects.toThrow('gebundenen Version');
    const wrongSize = {
      ...source,
      version: { ...source.version, sizeBytes: source.version.sizeBytes + 1n },
    };
    await expect(readIdentitySourceBytes(wrongSize)).rejects.toThrow('gebundenen Version');
  });
  it('rejects a crop for a stale version or unavailable source before reading storage', async () => {
    const { tx } = transaction();
    await expect(
      validateIdentityViewportsTx(
        tx,
        {
          ...input,
          views: [{ ...view, versionId: '22222222-2222-4222-8222-222222222222' }],
        },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow('geändert');
    await expect(
      validateIdentityViewportsTx(
        transaction(null).tx,
        { ...input, views: [view] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow('geändert');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('P-13 uses the page count stored at upload without reading or parsing the source', async () => {
    const doc = pdfDocumentFixture(Buffer.from('never-read'));
    doc.versions[0]!.pdfPageCount = 1;
    await expect(
      validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [{ ...view, page: 2 }] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow('PDF-Seite');
    expect(
      await validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [crop] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).toEqual([crop]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('P-13 counts pages of legacy PDFs before the transaction and only compares version and hash inside', async () => {
    const pdfBytes = await pdfWithPages(1);
    const doc = pdfDocumentFixture(pdfBytes);
    mocks.fetch.mockResolvedValue(pdfBytes);
    const pageCounts = await prepareIdentityPdfPageCounts(async () => [
      { source: await sourceOf(doc), views: [crop] },
    ]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(pageCounts.get(VERSION_ID)).toMatchObject({ outcome: { ok: true, pages: 1 } });
    await expect(
      validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [{ ...crop, page: 2 }] },
        pageCounts,
      ),
    ).rejects.toThrow('PDF-Seite');
    expect(
      await validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [crop] },
        pageCounts,
      ),
    ).toEqual([crop]);
    // Die Transaktion selbst liest keine Bytes.
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('P-13 rejects a legacy PDF crop as a changed source without a matching pre-count', async () => {
    const pdfBytes = await pdfWithPages(2);
    const doc = pdfDocumentFixture(pdfBytes);
    await expect(
      validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [crop] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow('geändert');
    mocks.fetch.mockResolvedValue(pdfBytes);
    const pageCounts = await prepareIdentityPdfPageCounts(async () => [
      { source: await sourceOf(doc), views: [crop] },
    ]);
    const rehashed = pdfDocumentFixture(pdfBytes);
    rehashed.versions[0]!.sha256 = createHash('sha256').update('other bytes').digest();
    await expect(
      validateIdentityViewportsTx(
        transaction(rehashed).tx,
        { ...input, views: [crop] },
        pageCounts,
      ),
    ).rejects.toThrow('geändert');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('P-13 keeps rejecting unreadable and tampered PDF sources', async () => {
    const garbage = Buffer.from('%PDF-1.7 not really a pdf');
    const doc = pdfDocumentFixture(garbage);
    mocks.fetch.mockResolvedValue(garbage);
    const unreadable = await prepareIdentityPdfPageCounts(async () => [
      { source: await sourceOf(doc), views: [crop] },
    ]);
    await expect(
      validateIdentityViewportsTx(transaction(doc).tx, { ...input, views: [crop] }, unreadable),
    ).rejects.toThrow('nicht gelesen');

    const pdfBytes = await pdfWithPages(1);
    const tampered = pdfDocumentFixture(pdfBytes);
    mocks.fetch.mockResolvedValue(Buffer.alloc(pdfBytes.length, 0));
    const mismatch = await prepareIdentityPdfPageCounts(async () => [
      { source: await sourceOf(tampered), views: [crop] },
    ]);
    await expect(
      validateIdentityViewportsTx(transaction(tampered).tx, { ...input, views: [crop] }, mismatch),
    ).rejects.toThrow('gebundenen Version');
  });
  it('P-13 pre-counts only PDF crops without stored count, once per version, and ignores reader failures', async () => {
    const pdfBytes = await pdfWithPages(3);
    mocks.fetch.mockResolvedValue(pdfBytes);
    const legacy = await sourceOf(pdfDocumentFixture(pdfBytes));
    const stored = await sourceOf(pdfDocumentFixture(pdfBytes));
    stored.version.pdfPageCount = 3;
    const image = await sourceOf(documentFixture());
    const pageCounts = await prepareIdentityPdfPageCounts(async () => [
      { source: legacy, views: [view] },
      { source: stored, views: [crop] },
      { source: image, views: [crop] },
      { source: legacy, views: [{ ...crop, versionId: '22222222-2222-4222-8222-222222222222' }] },
      { source: null, views: [crop] },
      { source: legacy, views: [crop] },
      { source: legacy, views: [{ ...crop, side: 'back' as const, page: 3 }] },
    ]);
    expect([...pageCounts.keys()]).toEqual([VERSION_ID]);
    expect(pageCounts.get(VERSION_ID)?.outcome).toEqual({ ok: true, pages: 3 });
    expect(mocks.fetch).toHaveBeenCalledOnce();

    const failed = await prepareIdentityPdfPageCounts(async () => {
      throw new Error('connection lost');
    });
    expect(failed.size).toBe(0);
  });
  it('P-13 loads sources only for selections that need a page check', async () => {
    const { tx, findFirst } = transaction(pdfDocumentFixture(Buffer.from('x')));
    expect(identityViewsNeedPageCheck([view])).toBe(false);
    expect(identityViewsNeedPageCheck([])).toBe(false);
    expect(identityViewsNeedPageCheck([{ ...view, rotation: 90 }])).toBe(true);
    expect(identityViewsNeedPageCheck([{ ...view, page: 2 }])).toBe(true);
    expect(identityViewsNeedPageCheck('kaputt')).toBe(false);
    const candidates = await loadIdentitySourcesForPageCheckTx(tx, input, [
      { documentId: 'manual', views: [view] },
      { documentId: 'document', views: [crop] },
    ]);
    expect(candidates).toHaveLength(1);
    expect(findFirst).toHaveBeenCalledOnce();
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({ id: 'document', clientId: 'client' });
  });
  it('GWG-SELF-ONBOARDING-001 permits manual full-original PDF capture without decoding, but rejects unverified crops', async () => {
    const doc = documentFixture();
    doc.mimeType = 'application/pdf';
    await expect(
      validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [view] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).resolves.toEqual([view]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await expect(
      validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [{ ...view, width: 0.5 }] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('rejects out-of-range crops and unsupported document formats', async () => {
    await expect(
      validateIdentityViewportsTx(
        transaction().tx,
        { ...input, views: [{ ...view, x: 0.5 }] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow('außerhalb');
    const doc = documentFixture();
    doc.mimeType = 'text/html';
    await expect(
      validateIdentityViewportsTx(
        transaction(doc).tx,
        { ...input, views: [view] },
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    ).rejects.toThrow('nur bei');
  });
});

describe('F-05 GWG-IDENTIFICATION-EVIDENCE-001: storage failures are not evidence conflicts', () => {
  it('wraps an object-store read failure as a storage error that keeps its cause', async () => {
    const s3Error = Object.assign(new Error('ServiceUnavailable'), { name: 'ServiceUnavailable' });
    mocks.fetch.mockRejectedValueOnce(s3Error);
    const source = (await loadIdentitySourceTx(transaction().tx, input))!;

    const error = await readIdentitySourceBytes(source).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentitySourceStorageError);
    expect((error as Error).cause).toBe(s3Error);
  });

  it('keeps a hash mismatch of readable bytes a source error, not a storage error', async () => {
    mocks.fetch.mockResolvedValueOnce(Buffer.from('tampered'));
    const source = (await loadIdentitySourceTx(transaction().tx, input))!;

    const error = await readIdentitySourceBytes(source).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(IdentitySourceStorageError);
    expect((error as Error).message).toContain('gebundenen Version');
  });

  it('propagates the storage error of the pre-count out of the viewport validation', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('socket hang up'));
    const doc = { ...documentFixture(), mimeType: 'application/pdf' };
    const pageCounts = await prepareIdentityPdfPageCounts(async () => [
      { source: await sourceOf(doc), views: [crop] },
    ]);

    await expect(
      validateIdentityViewportsTx(transaction(doc).tx, { ...input, views: [crop] }, pageCounts),
    ).rejects.toBeInstanceOf(IdentitySourceStorageError);
  });
});
