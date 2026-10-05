// =============================================================================
// Seitenzahl einer PDF-Ausweisquelle (P-13)
//
// Die Prüfung eines Ausweisausschnitts braucht bei PDFs die Seitenzahl. Bisher
// lud validateIdentityViewportsTx dafür die Originaldatei (bis 25 MiB) aus dem
// Objektspeicher und parste sie im Hauptthread, während Lifecycle-Lock und
// Zeilensperren gehalten wurden. Jetzt wird gezählt
//   • beim Upload einer GwG-PDF (gespeichert an der Dokumentversion) und
//   • für Altbestand ohne gespeicherten Wert vor der gesperrten Transaktion,
// beides im begrenzten Worker-Thread aus @taxtronik/mail (wie die
// Mail-Anhangsprüfung). pdf-lib lädt mit denselben Optionen wie bisher im
// Hauptthread, damit dieselben PDFs als lesbar gelten und dieselbe Seitenzahl
// ergeben.
// =============================================================================

import { runBoundedWorker, type BoundedWorkerLimits } from '@taxtronik/mail/bounded-worker';
import { log } from '@/server/logger';
import { LOAD_PARSER_SOURCE, workerParserBases } from '@/server/util/worker-parser';

/**
 * Großzügig für Ausweisquellen bis 25 MiB: Ein synthetisches 25-MiB-PDF mit
 * 40.000 Seiten brauchte lokal rund 3,6 s und 220 MiB RSS-Zuwachs, ein
 * Ausweisscan (ein Bild) unter 0,3 s. Was darüber liegt, gilt als nicht
 * lesbar, statt den Webprozess zu blockieren.
 */
export const IDENTITY_PDF_PAGE_COUNT_LIMITS: BoundedWorkerLimits = {
  timeoutMs: 30_000,
  rssBudgetBytes: 512 * 1024 * 1024,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

// Nur dieses feste Programm wird ausgewertet; die Dateibytes sind Daten. Die
// Ladeoptionen entsprechen dem bisherigen Aufruf in validateIdentityViewportsTx.
// pdf-lib wird außerhalb des try geladen: Fehlt der Parser, endet der Thread
// mit einem Fehler statt mit einer scheinbar unlesbaren Datei.
const PAGE_COUNT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
${LOAD_PARSER_SOURCE}
const { PDFDocument } = loadParser('pdf-lib');
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
 * Seitenzahl laut pdf-lib oder `null`, wenn die Datei nicht gelesen werden
 * konnte (beschädigt, verschlüsselt, Zeit- oder Speichergrenze überschritten).
 */
export async function countIdentityPdfPages(
  bytes: Uint8Array,
  limits: BoundedWorkerLimits = IDENTITY_PDF_PAGE_COUNT_LIMITS,
): Promise<number | null> {
  const result = await runBoundedWorker<unknown>(
    PAGE_COUNT_WORKER,
    { bytes, parserBases: workerParserBases() },
    limits,
  );
  if (!result.ok && (result.reason === 'error' || result.reason === 'spawn')) {
    // Kein Dateiinhalt im Log: nur, dass Thread oder Parser nicht verfügbar war.
    log.error(
      { component: 'gwg-identity-pdf', reason: result.reason },
      'PDF-Seitenzählung: Worker-Thread ohne Ergebnis',
    );
  }
  return result.ok && Number.isSafeInteger(result.value) && (result.value as number) >= 0
    ? (result.value as number)
    : null;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * Seitenzahl für eine neue Dokumentversion: nur bei GwG-Belegen, die als PDF
 * gemeldet oder erkannt sind; sonst `null` ohne Parsing. Ein Fehlschlag
 * verhindert den Upload nicht (`null`): Die Ausschnittsprüfung zählt dann wie
 * beim Altbestand vor ihrer Transaktion und lehnt eine unlesbare PDF ab wie
 * bisher.
 */
export async function identityPdfPageCountForUpload(input: {
  classification: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<number | null> {
  if (input.classification !== 'GWG_EVIDENCE') return null;
  const looksLikePdf =
    input.mimeType === 'application/pdf' ||
    input.bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  return looksLikePdf ? countIdentityPdfPages(input.bytes) : null;
}
