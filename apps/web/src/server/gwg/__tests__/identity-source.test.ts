import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { PDFDocument } from 'pdf-lib';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({ fetchObjectBytes: mocks.fetch }));
import {
  loadIdentitySourceTx,
  readIdentitySourceBytes,
  validateIdentityViewportsTx,
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
      validateIdentityViewportsTx(tx, {
        ...input,
        views: [{ ...view, versionId: '22222222-2222-4222-8222-222222222222' }],
      }),
    ).rejects.toThrow('geändert');
    await expect(
      validateIdentityViewportsTx(transaction(null).tx, { ...input, views: [view] }),
    ).rejects.toThrow('geändert');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('validates PDF page counts against hash-verified original bytes', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const pdfBytes = Buffer.from(await pdf.save());
    const doc = documentFixture();
    doc.mimeType = 'application/pdf';
    doc.versions[0]!.sha256 = createHash('sha256').update(pdfBytes).digest();
    doc.versions[0]!.sizeBytes = BigInt(pdfBytes.length);
    mocks.fetch.mockResolvedValue(pdfBytes);
    await expect(
      validateIdentityViewportsTx(transaction(doc).tx, { ...input, views: [{ ...view, page: 2 }] }),
    ).rejects.toThrow('PDF-Seite');
    expect(
      await validateIdentityViewportsTx(transaction(doc).tx, { ...input, views: [view] }),
    ).toEqual([view]);
  });
  it('GWG-SELF-ONBOARDING-001 permits manual full-original PDF capture without decoding, but rejects unverified crops', async () => {
    const doc = documentFixture();
    doc.mimeType = 'application/pdf';
    await expect(
      validateIdentityViewportsTx(transaction(doc).tx, { ...input, views: [view] }),
    ).resolves.toEqual([view]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await expect(
      validateIdentityViewportsTx(transaction(doc).tx, {
        ...input,
        views: [{ ...view, width: 0.5 }],
      }),
    ).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('rejects out-of-range crops and unsupported document formats', async () => {
    await expect(
      validateIdentityViewportsTx(transaction().tx, { ...input, views: [{ ...view, x: 0.5 }] }),
    ).rejects.toThrow('außerhalb');
    const doc = documentFixture();
    doc.mimeType = 'text/html';
    await expect(
      validateIdentityViewportsTx(transaction(doc).tx, { ...input, views: [view] }),
    ).rejects.toThrow('nur bei');
  });
});
