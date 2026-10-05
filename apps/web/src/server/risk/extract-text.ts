// =============================================================================
// Dokument -> Klartext für den Subsumtions-Workspace.
//
// Extrahiert den Text aus PDF (unpdf) und Word-.docx (mammoth), damit der
// Berater einen Sachverhalt nicht abtippen muss. Der extrahierte Text ist nur
// ein EDITOR-SEED — analysiert (und gehasht) wird am Ende der vom Berater final
// bearbeitete Text. Reine Transformation; kein DB-/Netzwerk-Zugriff.
//
// DOCX läuft über convertToHtml (Struktur bleibt erhalten: Absätze, Listen,
// Tabellen) → htmlToText. Bilder werden NICHT analysierbar — sie hinterlassen
// einen sichtbaren `[Grafik]`-Platzhalter, damit der Berater weiß, dass dort
// etwas war (statt stiller Lücke). `cleanup()` räumt Whitespace-Artefakte auf:
// Leerzeilen-Ketten (Seitenumbrüche), Seitenzahl-Zeilen, Soft-Hyphens, am
// Zeilenende getrennte Wörter (nur Kleinbuchstaben, konservativ).
//
// Für bereits hochgeladene Mandanten-Dokumente liefert
// `fetchObjectBytes(bucket, storageKey)` (@taxtronik/storage) die Bytes.
//
// P-22: PDF (unpdf/pdf.js) und DOCX (mammoth) bis 25 MiB werden nicht mehr im
// Event-Loop des Webprozesses geparst, sondern in einem begrenzten Worker-Thread
// (Frist, V8-Heap, RSS-Wächter; @taxtronik/mail/bounded-worker). Beide Parser
// sind deshalb `serverExternalPackages` (next.config.mjs), damit der Thread sie
// als echte Node-Module laden kann (Auflösung im Thread, siehe
// util/worker-parser.ts). Nur die Rohausgabe kommt zurück; die Aufbereitung
// (htmlToText, cleanup) bleibt hier.
// =============================================================================

import { runBoundedWorker, type BoundedWorkerLimits } from '@taxtronik/mail/bounded-worker';
import { log } from '@/server/logger';
import { LOAD_PARSER_SOURCE, workerParserBases } from '@/server/util/worker-parser';

export class UnsupportedDocumentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDocumentTypeError';
  }
}

/** Datei ließ sich innerhalb der Grenzen nicht lesen (beschädigt, zu komplex, verschlüsselt). */
export class TextExtractionFailedError extends UnsupportedDocumentTypeError {
  constructor() {
    super(
      'Der Text konnte nicht ausgelesen werden (Datei beschädigt, verschlüsselt oder zu komplex).',
    );
    this.name = 'TextExtractionFailedError';
  }
}

export const TEXT_EXTRACTION_LIMITS: BoundedWorkerLimits = {
  timeoutMs: 30_000,
  rssBudgetBytes: 512 * 1024 * 1024,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

// Festes Programm; die Dokument-Bytes sind ausschließlich Daten (workerData).
// Der Parser wird außerhalb des try geladen: Fehlt er, endet der Thread mit
// einem Fehler (reason 'error') statt mit einer scheinbar unlesbaren Datei.
const EXTRACTION_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
${LOAD_PARSER_SOURCE}
const parser = loadParser(workerData.kind === 'pdf' ? 'unpdf' : 'mammoth');
(async () => {
  try {
    if (workerData.kind === 'pdf') {
      const { extractText, getDocumentProxy } = parser;
      const pdf = await getDocumentProxy(new Uint8Array(workerData.bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      parentPort.postMessage({ ok: true, text: String(text) });
    } else {
      const mammoth = parser;
      const { value } = await mammoth.convertToHtml(
        { buffer: Buffer.from(workerData.bytes) },
        { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
      );
      parentPort.postMessage({ ok: true, text: String(value) });
    }
  } catch {
    parentPort.postMessage({ ok: false });
  }
})();
`;

async function extractInWorker(kind: 'pdf' | 'docx', bytes: Buffer): Promise<string> {
  const result = await runBoundedWorker<{ ok: boolean; text?: string }>(
    EXTRACTION_WORKER,
    { kind, bytes, parserBases: workerParserBases() },
    TEXT_EXTRACTION_LIMITS,
  );
  if (!result.ok && (result.reason === 'error' || result.reason === 'spawn')) {
    // Kein Dokumentinhalt im Log: nur, dass Thread oder Parser nicht verfügbar war.
    log.error(
      { component: 'risk-extract-text', kind, reason: result.reason },
      'Textextraktion: Worker-Thread ohne Ergebnis',
    );
  }
  if (!result.ok || !result.value.ok || typeof result.value.text !== 'string') {
    throw new TextExtractionFailedError();
  }
  return result.value.text;
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

const NBSP = '\u00a0';
// Unsichtbare Zeichen (Zero-Width + Soft-Hyphen) per Code-Point gebaut, damit
// die Quelle ASCII bleibt (keine literalen Steuerzeichen im Code).
const INVISIBLE = new RegExp(
  '[' +
    [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad].map((c) => String.fromCharCode(c)).join('') +
    ']',
  'g',
);

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** mammoth-HTML → strukturierter Klartext (Bild→Platzhalter, Tabelle→Zellen). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<img\b[^>]*>/gi, ' [Grafik] ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  // Tabellen: Zellen mit Strich trennen, Zeilen mit Umbruch.
  s = s.replace(/<\/(?:td|th)>\s*<(?:td|th)\b[^>]*>/gi, '  │  ');
  s = s.replace(/<\/tr>/gi, '\n');
  // Block-Enden → Absatz.
  s = s.replace(/<\/(?:p|h[1-6]|ul|ol|table|div|blockquote|tr|li)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

/**
 * Räumt extrahierten Text auf — gemeinsam für PDF/DOCX/Text:
 * Zeilenenden, NBSP/Zero-Width, Soft-Hyphen, Form-Feed (Seitenumbruch),
 * mehrfache Leerzeichen, Seitenzahl-Zeilen, am Zeilenende getrennte Wörter,
 * Leerzeilen-Ketten. Bewusst KEIN aggressives Reflow (s. Modul-Kopf).
 */
export function cleanup(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .split(NBSP)
      .join(' ')
      .replace(INVISIBLE, '')
      // Form-Feed / Vertical-Tab (Seitenumbruch) → Absatz.
      .replace(/[\f\v]+/g, '\n\n')
      // Am Zeilenende getrenntes Wort wieder zusammensetzen (nur klein-klein,
      // konservativ — vermeidet das Verschmelzen echter Bindestrich-Komposita).
      .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
      // Trailing Whitespace je Zeile.
      .replace(/[ \t]+$/gm, '')
      // Mehrfach-Leerzeichen (PDF-Layout) → eins.
      .replace(/ {2,}/g, ' ')
      // Reine Seitenzahl-Zeilen entfernen ("12", "- 12 -", "Seite 12 von 34").
      .replace(/^[ \t]*(?:seite\s+)?\d{1,4}(?:\s+von\s+\d{1,4})?[ \t]*$/gim, '')
      .replace(/^[ \t]*[-–—][ \t]*\d{1,4}[ \t]*[-–—][ \t]*$/gm, '')
      // Leerzeilen-Ketten (Seitenumbruch-Lücken) → max. eine Leerzeile.
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
      .trim()
  );
}

export async function extractText(bytes: Buffer, mime: string): Promise<string> {
  const m = mime.split(';')[0]!.trim().toLowerCase();

  if (m === PDF_MIME) {
    return cleanup(await extractInWorker('pdf', bytes));
  }

  if (m === DOCX_MIME) {
    // convertToHtml statt extractRawText: behält Absätze/Listen/Tabellen und
    // macht Bilder sichtbar (Platzhalter). Bilder ohne base64 inlinen (src leer)
    // → htmlToText ersetzt sie durch [Grafik], kein MB-großer Data-URI im Text.
    return cleanup(htmlToText(await extractInWorker('docx', bytes)));
  }

  if (m === DOC_MIME) {
    throw new UnsupportedDocumentTypeError(
      'Das alte .doc-Format wird nicht unterstützt — bitte als .docx oder PDF speichern.',
    );
  }

  if (m.startsWith('text/')) {
    return cleanup(bytes.toString('utf-8'));
  }

  throw new UnsupportedDocumentTypeError(`Nicht unterstützter Dokumenttyp: ${mime}`);
}
