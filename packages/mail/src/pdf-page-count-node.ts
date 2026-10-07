// =============================================================================
// Seitenzählung für Node-Prozesse ohne Bundler-Umschreibung (Worker, P-13)
//
// Der Worker-Prozess löst pdf-lib wie die Mail-Anhangsprüfung (attachments.ts)
// über require.resolve aus diesem Paket auf: im Image liegt pdf-lib als
// Abhängigkeit von @taxtronik/mail im per `pnpm deploy` befüllten
// node_modules. Die Web-App darf dieses Modul nicht verwenden (Turbopack
// ersetzt require.resolve im Produktionsbuild durch eine Modul-ID); sie zählt
// über apps/web/src/server/gwg/identity-pdf-pages.ts mit demselben Programm
// und denselben Grenzen aus pdf-page-count.ts.
// =============================================================================

import { createRequire } from 'node:module';
import { runBoundedWorker, type BoundedWorkerLimits } from './bounded-worker';
import {
  PDF_PAGE_COUNT_LIMITS,
  PDF_PAGE_COUNT_PROGRAM_BODY,
  pdfPageCountOutcome,
  type PdfPageCountOutcome,
} from './pdf-page-count';

const require = createRequire(import.meta.url);

const PROGRAM = `
const { parentPort, workerData } = require('node:worker_threads');
const { PDFDocument } = require(workerData.parserPath);
${PDF_PAGE_COUNT_PROGRAM_BODY}`;

/** Zählt die Seiten einer PDF im begrenzten Worker-Thread (siehe PdfPageCountOutcome). */
export async function countPdfPagesInWorkerThread(
  bytes: Uint8Array,
  limits: BoundedWorkerLimits = PDF_PAGE_COUNT_LIMITS,
): Promise<PdfPageCountOutcome> {
  let parserPath: string;
  try {
    parserPath = require.resolve('pdf-lib');
  } catch {
    // Wie ein im Thread nicht ladbarer Parser: kein Urteil über die Datei.
    return { status: 'unavailable', reason: 'error' };
  }
  return pdfPageCountOutcome(
    await runBoundedWorker<unknown>(PROGRAM, { bytes, parserPath }, limits),
  );
}
