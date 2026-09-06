import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from '../../../public/fonts/noto/manifest.json';
import { ActionError } from '../actions/action-error';

type Face =
  | 'NotoSans-Regular.ttf'
  | 'NotoSans-Bold.ttf'
  | 'NotoSansSC-Regular.otf'
  | 'NotoSansSC-Bold.otf';
type Run = { face: Face; text: string };
const files = new Map(manifest.fonts.map((f) => [f.file, f]));
const buffers = new Map<Face, Buffer>();
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const installed = new WeakSet<PDFKit.PDFDocument>();
const lineControls = new Set([9, 10, 13]);

export class UnsupportedPdfTextError extends ActionError {
  constructor(codepoints: number[]) {
    super(
      `PDF-Ausgabe gesperrt: Zeichen ${codepoints
        .slice(0, 8)
        .map((cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'))
        .join(
          ', ',
        )} sind mit den eingebetteten Schriften nicht verlustfrei darstellbar. Bitte eine passende Schrift ergänzen; Namen nicht still ersetzen.`,
    );
    this.name = 'UnsupportedPdfTextError';
  }
}
function covered(face: Face, cp: number): boolean {
  return (
    lineControls.has(cp) || files.get(face)!.coverage.some(([from, to]) => cp >= from! && cp <= to!)
  );
}
/** An entire grapheme uses one face; combining marks must not be separated from their base. */
export function pdfFontRuns(text: string, bold = false): Run[] {
  const preferred: Face = bold ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf';
  const fallback: Face = bold ? 'NotoSansSC-Bold.otf' : 'NotoSansSC-Regular.otf';
  const result: Run[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const codepoints = [...segment].map((c) => c.codePointAt(0)!);
    const face = [preferred, fallback].find((font) => codepoints.every((cp) => covered(font, cp)));
    if (!face) throw new UnsupportedPdfTextError(codepoints);
    const last = result.at(-1);
    if (last?.face === face) last.text += segment;
    else result.push({ face, text: segment });
  }
  return result;
}
function fontBytes(face: Face): Buffer {
  let bytes = buffers.get(face);
  if (bytes) return bytes;
  // Both supported launch locations: Next's apps/web cwd and repository/standalone root.
  const candidates = [
    path.join(process.cwd(), 'public/fonts/noto', face),
    path.join(process.cwd(), 'apps/web/public/fonts/noto', face),
  ];
  const filename = candidates.find((file) => existsSync(file));
  if (!filename) throw new Error('PDF-Schriftdateien fehlen in der Installation.');
  bytes = readFileSync(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== files.get(face)!.sha256)
    throw new Error('PDF-Schriftdateien stimmen nicht mit dem geprüften Stand überein.');
  buffers.set(face, bytes);
  return bytes;
}

/** Install before the first text operation. Existing Helvetica/Helvetica-Bold
 * calls retain their weight; text uses embedded Noto faces with checked fallback.
 * This opt-in adapter does not change the other historical PDF generators. */
export function installUnicodePdfFonts(doc: PDFKit.PDFDocument): PDFKit.PDFDocument {
  if (installed.has(doc)) return doc;
  for (const face of files.keys() as IterableIterator<Face>)
    doc.registerFont(face, fontBytes(face));
  const originalFont = doc.font.bind(doc);
  const originalText = doc.text.bind(doc);
  let bold = false;
  doc.font = ((
    font: Parameters<PDFKit.PDFDocument['font']>[0],
    familyOrSize?: string | number,
    size?: number,
  ) => {
    if (
      typeof font !== 'string' ||
      !['Helvetica', 'Helvetica-Bold', 'NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'].includes(font)
    )
      throw new Error('PDF-Generator fordert eine nicht freigegebene Schrift an.');
    bold = font === 'Helvetica-Bold' || font === 'NotoSans-Bold.ttf';
    const selected: Face = bold ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf';
    return typeof familyOrSize === 'number'
      ? originalFont(selected, familyOrSize)
      : typeof size === 'number'
        ? originalFont(selected, size)
        : originalFont(selected);
  }) as typeof doc.font;
  doc.text = ((
    value: string,
    xOrOptions?: number | PDFKit.Mixins.TextOptions,
    y?: number,
    options?: PDFKit.Mixins.TextOptions,
  ) => {
    const text = String(value ?? '');
    const runs = pdfFontRuns(text, bold); // Fail before drawing any portion of this text call.
    const opts = typeof xOrOptions === 'object' ? xOrOptions : options;
    if (!runs.length)
      return typeof xOrOptions === 'number'
        ? originalText(text, xOrOptions, y, opts)
        : originalText(text, opts);
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      originalFont(run.face);
      const runOptions = { ...opts, continued: i < runs.length - 1 || opts?.continued === true };
      if (i === 0 && typeof xOrOptions === 'number')
        originalText(run.text, xOrOptions, y, runOptions);
      else originalText(run.text, runOptions);
    }
    originalFont(bold ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf');
    return doc;
  }) as typeof doc.text;
  originalFont('NotoSans-Regular.ttf');
  installed.add(doc);
  return doc;
}
