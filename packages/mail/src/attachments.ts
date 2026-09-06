import { createRequire } from 'node:module';
import { memoryUsage } from 'node:process';
import { Worker } from 'node:worker_threads';
import { detectMimeFromMagicBytes, MAX_UPLOAD_BYTES } from '@taxtronik/storage';

const require = createRequire(import.meta.url);
const PDF_TIMEOUT_MS = 5000;
const PDF_RSS_BUDGET = 128 * 1024 * 1024;
// Only this fixed program is evaluated. Attachment bytes are data, never source code.
const PDF_PREFLIGHT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { PDFDocument } = require(workerData.parserPath);
(async () => {
  try {
    const document = await PDFDocument.load(workerData.bytes, {
      ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false,
    });
    parentPort.postMessage(!document.isEncrypted && document.getPageCount() > 0);
  } catch {
    parentPort.postMessage(false);
  }
})();
`;

/** Keep untrusted PDF parsing outside the queue's event loop. V8 heap limits
 * do not cover ArrayBuffers, so the parent also watches process RSS growth.
 * The RSS watchdog is conservative under concurrent work, not an OS hard limit. */
async function boundedPdfPreflight(bytes: Buffer): Promise<boolean> {
  const baselineRss = memoryUsage.rss();
  let worker: Worker;
  try {
    worker = new Worker(PDF_PREFLIGHT_WORKER, {
      eval: true,
      workerData: { bytes, parserPath: require.resolve('pdf-lib') },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
  } catch {
    return false;
  }
  // PDF parser diagnostics may contain untrusted content; never forward them to logs.
  worker.stdout?.resume();
  worker.stderr?.resume();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(memoryWatch);
      void worker.terminate().catch(() => undefined);
      resolve(valid);
    };
    const deadline = setTimeout(() => finish(false), PDF_TIMEOUT_MS);
    const memoryWatch = setInterval(() => {
      if (memoryUsage.rss() - baselineRss > PDF_RSS_BUDGET) finish(false);
    }, 25);
    worker.once('message', (result) => finish(result === true));
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
  });
}

/** Conservative preflight: no archive extraction or unverified encrypted files. */
export async function classifyInboundAttachment(
  bytes: Buffer,
): Promise<{ mime: string; blocked: string | null }> {
  const mime = detectMimeFromMagicBytes(bytes) ?? 'application/octet-stream';
  if (bytes.length > MAX_UPLOAD_BYTES) return { mime, blocked: 'Datei zu groß.' };
  if (
    ![
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/tiff',
      'application/xml',
    ].includes(mime)
  )
    return {
      mime,
      blocked: 'Dateityp nicht automatisch prüfbar; bitte sicher über das Portal anfordern.',
    };
  if (mime === 'application/pdf') {
    if (!(await boundedPdfPreflight(bytes)))
      return {
        mime,
        blocked:
          'PDF verschlüsselt, beschädigt oder innerhalb der Ressourcenlimits nicht sicher prüfbar.',
      };
  }
  return { mime, blocked: null };
}
