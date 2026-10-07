// =============================================================================
// Seitenzahl einer PDF im begrenzten Worker-Thread (P-13)
//
// Gemeinsame Grundlage für die Zählung beim Upload (Web,
// apps/web/src/server/gwg/identity-pdf-pages.ts) und den Nachtrag im Worker
// (apps/worker/src/jobs/pdf-page-count-backfill.ts): dasselbe pdf-lib-Programm
// mit denselben Ladeoptionen und Grenzen, damit beide Wege dieselben PDFs als
// lesbar werten und dieselbe Seitenzahl ergeben.
//
// Wie pdf-lib im Thread geladen wird, entscheidet der Aufrufer: Die Web-App
// löst den Parser selbst im Thread auf (Turbopack ersetzt require.resolve im
// Produktionsbuild), der Worker über pdf-page-count-node.ts.
// =============================================================================

import type { BoundedWorkerLimits, BoundedWorkerResult } from './bounded-worker';

/**
 * Großzügig für Ausweisquellen bis 25 MiB: Ein synthetisches 25-MiB-PDF mit
 * 40.000 Seiten brauchte lokal rund 3,6 s und 220 MiB RSS-Zuwachs, ein
 * Ausweisscan (ein Bild) unter 0,3 s. Was darüber liegt, gilt als nicht
 * lesbar, statt den Prozess zu blockieren.
 */
export const PDF_PAGE_COUNT_LIMITS: Readonly<BoundedWorkerLimits> = Object.freeze({
  timeoutMs: 30_000,
  rssBudgetBytes: 512 * 1024 * 1024,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});

/**
 * Programmteil nach `const { parentPort, workerData } = …` und dem Laden von
 * pdf-lib als `PDFDocument`. Nur dieses feste Programm wird ausgewertet; die
 * Dateibytes (`workerData.bytes`) sind Daten. Die Ladeoptionen entsprechen
 * dem früheren Aufruf in validateIdentityViewportsTx.
 */
export const PDF_PAGE_COUNT_PROGRAM_BODY = `
(async () => {
  try {
    const document = await PDFDocument.load(workerData.bytes, { updateMetadata: false });
    parentPort.postMessage(document.getPageCount());
  } catch {
    parentPort.postMessage(null);
  }
})();
`;

/**
 * Ausgang einer Zählung:
 * - `counted`: pdf-lib hat die Datei gelesen;
 * - `unreadable`: pdf-lib lehnt die Datei ab (beschädigt, verschlüsselt, kein
 *   PDF) oder sie überschreitet Zeit- bzw. Speichergrenze;
 * - `unavailable`: der Thread lieferte kein Ergebnis (Start fehlgeschlagen,
 *   Parser nicht ladbar, Heap-Grenze, Abbruch). Das sagt über die Datei nichts
 *   Verlässliches aus; ein Nachtrag versucht es später erneut.
 */
export type PdfPageCountOutcome =
  | { status: 'counted'; pages: number }
  | { status: 'unreadable'; reason: 'parser' | 'timeout' | 'memory' }
  | { status: 'unavailable'; reason: 'spawn' | 'error' | 'exit' };

export function pdfPageCountOutcome(result: BoundedWorkerResult<unknown>): PdfPageCountOutcome {
  if (result.ok) {
    return Number.isSafeInteger(result.value) && (result.value as number) >= 0
      ? { status: 'counted', pages: result.value as number }
      : { status: 'unreadable', reason: 'parser' };
  }
  switch (result.reason) {
    case 'timeout':
    case 'memory':
      return { status: 'unreadable', reason: result.reason };
    default:
      return { status: 'unavailable', reason: result.reason };
  }
}

/** Seitenzahl oder `null` (nicht lesbar oder kein Ergebnis), wie beim Upload gespeichert. */
export function pdfPageCountValue(outcome: PdfPageCountOutcome): number | null {
  return outcome.status === 'counted' ? outcome.pages : null;
}
