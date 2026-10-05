// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-SELF-ONBOARDING-001
// P-13: Die Seitenzahl einer PDF-Ausweisquelle wird beim Upload bzw. vor der
// Transaktion im begrenzten Worker-Thread gezählt. Dieselben PDFs müssen dabei
// lesbar bzw. unlesbar sein und dieselbe Seitenzahl ergeben wie bisher mit
// PDFDocument.load im Hauptthread (gleiche Annahmeentscheidung).
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const h = vi.hoisted(() => ({ runBoundedWorker: vi.fn() }));
vi.mock('@taxtronik/mail/bounded-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/mail/bounded-worker')>();
  h.runBoundedWorker.mockImplementation(actual.runBoundedWorker);
  return { ...actual, runBoundedWorker: h.runBoundedWorker };
});

import {
  countIdentityPdfPages,
  IDENTITY_PDF_PAGE_COUNT_LIMITS,
  identityPdfPageCountForUpload,
} from '../identity-pdf-pages';

async function pdfWithPages(pages: number, useObjectStreams = true): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) pdf.addPage([200, 200]).drawText(`Seite ${page}`);
  return Buffer.from(await pdf.save({ useObjectStreams, addDefaultPage: false }));
}

/** Bisheriges Verhalten von validateIdentityViewportsTx im Hauptthread. */
async function mainThreadPageCount(bytes: Buffer): Promise<number | null> {
  try {
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch {
    return null;
  }
}

async function corpus(): Promise<Array<[string, Buffer]>> {
  const classic = await pdfWithPages(2, false);
  const encrypted = Buffer.from(
    classic
      .toString('latin1')
      .replace(/trailer\s*<</, 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>'),
    'latin1',
  );
  const threePages = await pdfWithPages(3);
  return [
    ['ohne Seiten', await pdfWithPages(0)],
    ['eine Seite', await pdfWithPages(1)],
    ['drei Seiten', threePages],
    ['120 Seiten, klassische Xref', await pdfWithPages(120, false)],
    ['verschlüsselt', encrypted],
    ['abgeschnitten', threePages.subarray(0, Math.floor(threePages.length / 2))],
    ['nur Kopfzeile', Buffer.from('%PDF-1.7\n%%EOF\n')],
    ['PNG-Signatur', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
  ];
}

describe('P-13 countIdentityPdfPages', () => {
  it('liefert für jede Datei dieselbe Seitenzahl bzw. Ablehnung wie pdf-lib im Hauptthread', async () => {
    const results = [];
    for (const [label, bytes] of await corpus()) {
      results.push({
        label,
        worker: await countIdentityPdfPages(bytes),
        mainThread: await mainThreadPageCount(bytes),
      });
    }
    for (const result of results) expect(result.worker, result.label).toBe(result.mainThread);
    // Der Korpus deckt beide Ausgänge ab.
    expect(results.find((result) => result.label === 'drei Seiten')?.worker).toBe(3);
    expect(results.find((result) => result.label === 'ohne Seiten')?.worker).toBe(0);
    expect(results.find((result) => result.label === 'verschlüsselt')?.worker).toBeNull();
    expect(results.find((result) => result.label === 'PNG-Signatur')?.worker).toBeNull();
  });

  it('wertet eine überschrittene Grenze als nicht lesbar statt den Prozess zu blockieren', async () => {
    const bytes = await pdfWithPages(1);
    expect(
      await countIdentityPdfPages(bytes, { ...IDENTITY_PDF_PAGE_COUNT_LIMITS, timeoutMs: 1 }),
    ).toBeNull();
    expect(
      await countIdentityPdfPages(bytes, { ...IDENTITY_PDF_PAGE_COUNT_LIMITS, rssBudgetBytes: -1 }),
    ).toBeNull();
  });
});

describe('P-13 identityPdfPageCountForUpload', () => {
  it('zählt nur GwG-Belege, die als PDF gemeldet oder erkannt sind', async () => {
    const pdf = await pdfWithPages(2);
    h.runBoundedWorker.mockClear();
    expect(
      await identityPdfPageCountForUpload({
        classification: 'GENERAL',
        mimeType: 'application/pdf',
        bytes: pdf,
      }),
    ).toBeNull();
    expect(
      await identityPdfPageCountForUpload({
        classification: 'GWG_EVIDENCE',
        mimeType: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }),
    ).toBeNull();
    expect(h.runBoundedWorker).not.toHaveBeenCalled();

    expect(
      await identityPdfPageCountForUpload({
        classification: 'GWG_EVIDENCE',
        mimeType: 'application/pdf',
        bytes: pdf,
      }),
    ).toBe(2);
    expect(
      await identityPdfPageCountForUpload({
        classification: 'GWG_EVIDENCE',
        mimeType: 'application/octet-stream',
        bytes: pdf,
      }),
    ).toBe(2);
    expect(
      await identityPdfPageCountForUpload({
        classification: 'GWG_EVIDENCE',
        mimeType: 'application/pdf',
        bytes: Buffer.from('kein PDF'),
      }),
    ).toBeNull();
    expect(h.runBoundedWorker).toHaveBeenCalledTimes(3);
  });
});
