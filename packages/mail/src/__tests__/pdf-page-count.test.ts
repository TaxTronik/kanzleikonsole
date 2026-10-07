// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// P-13: Seitenzählung im begrenzten Worker-Thread, gemeinsam für den Upload
// (Web) und den Nachtrag im Worker. Der Worker-Weg muss dieselben PDFs als
// lesbar werten und dieselbe Seitenzahl liefern wie pdf-lib im Hauptthread
// (frühere Entscheidung der Ausschnittsprüfung); Grenzen gelten als „nicht
// lesbar“, ein Thread ohne Ergebnis sagt über die Datei nichts aus.
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  PDF_PAGE_COUNT_LIMITS,
  PDF_PAGE_COUNT_PROGRAM_BODY,
  pdfPageCountOutcome,
  pdfPageCountValue,
} from '../pdf-page-count';
import { countPdfPagesInWorkerThread } from '../pdf-page-count-node';

async function pdfWithPages(pages: number, useObjectStreams = true): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) pdf.addPage([200, 200]).drawText(`Seite ${page}`);
  return Buffer.from(await pdf.save({ useObjectStreams, addDefaultPage: false }));
}

async function mainThreadPageCount(bytes: Buffer): Promise<number | null> {
  try {
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
  } catch {
    return null;
  }
}

describe('P-13 pdfPageCountOutcome', () => {
  it('trennt Seitenzahl, nicht lesbare Datei und fehlendes Ergebnis', () => {
    expect(pdfPageCountOutcome({ ok: true, value: 3 })).toEqual({ status: 'counted', pages: 3 });
    expect(pdfPageCountOutcome({ ok: true, value: 0 })).toEqual({ status: 'counted', pages: 0 });
    for (const value of [null, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(pdfPageCountOutcome({ ok: true, value })).toEqual({
        status: 'unreadable',
        reason: 'parser',
      });
    }
    expect(pdfPageCountOutcome({ ok: false, reason: 'timeout' })).toEqual({
      status: 'unreadable',
      reason: 'timeout',
    });
    expect(pdfPageCountOutcome({ ok: false, reason: 'memory' })).toEqual({
      status: 'unreadable',
      reason: 'memory',
    });
    for (const reason of ['spawn', 'error', 'exit'] as const) {
      expect(pdfPageCountOutcome({ ok: false, reason })).toEqual({ status: 'unavailable', reason });
    }
    expect(pdfPageCountValue({ status: 'counted', pages: 2 })).toBe(2);
    expect(pdfPageCountValue({ status: 'unreadable', reason: 'parser' })).toBeNull();
    expect(pdfPageCountValue({ status: 'unavailable', reason: 'spawn' })).toBeNull();
  });

  it('hält Programm und Grenzen fest (dieselben für Upload und Nachtrag)', () => {
    expect(PDF_PAGE_COUNT_LIMITS).toEqual({
      timeoutMs: 30_000,
      rssBudgetBytes: 512 * 1024 * 1024,
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    });
    expect(Object.isFrozen(PDF_PAGE_COUNT_LIMITS)).toBe(true);
    expect(PDF_PAGE_COUNT_PROGRAM_BODY).toContain(
      'PDFDocument.load(workerData.bytes, { updateMetadata: false })',
    );
    expect(PDF_PAGE_COUNT_PROGRAM_BODY).toContain('parentPort.postMessage(null)');
  });
});

describe('P-13 countPdfPagesInWorkerThread', () => {
  it('liefert dieselbe Seitenzahl bzw. Ablehnung wie pdf-lib im Hauptthread', async () => {
    const threePages = await pdfWithPages(3);
    const classic = await pdfWithPages(2, false);
    const encrypted = Buffer.from(
      classic
        .toString('latin1')
        .replace(/trailer\s*<</, 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>'),
      'latin1',
    );
    const corpus: Array<[string, Buffer]> = [
      ['ohne Seiten', await pdfWithPages(0)],
      ['drei Seiten', threePages],
      ['klassische Xref', classic],
      ['verschlüsselt', encrypted],
      ['abgeschnitten', threePages.subarray(0, Math.floor(threePages.length / 2))],
      ['kein PDF', Buffer.from('kein PDF')],
    ];
    for (const [label, bytes] of corpus) {
      const outcome = await countPdfPagesInWorkerThread(bytes);
      expect(outcome.status, label).not.toBe('unavailable');
      expect(pdfPageCountValue(outcome), label).toBe(await mainThreadPageCount(bytes));
    }
    expect(await countPdfPagesInWorkerThread(threePages)).toEqual({ status: 'counted', pages: 3 });
    expect(await countPdfPagesInWorkerThread(encrypted)).toEqual({
      status: 'unreadable',
      reason: 'parser',
    });
  });

  it('wertet eine überschrittene Zeitgrenze als nicht lesbar', async () => {
    expect(
      await countPdfPagesInWorkerThread(await pdfWithPages(1), {
        ...PDF_PAGE_COUNT_LIMITS,
        timeoutMs: 1,
      }),
    ).toEqual({ status: 'unreadable', reason: 'timeout' });
  });
});
