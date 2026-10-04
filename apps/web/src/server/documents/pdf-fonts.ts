import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import manifest from '../../../public/fonts/noto/manifest.json';
import { ActionError } from '../actions/action-error';

export type PdfFontFace =
  | 'NotoSans-Regular.ttf'
  | 'NotoSans-Bold.ttf'
  | 'NotoSansSC-Regular.otf'
  | 'NotoSansSC-Bold.otf';
type Face = PdfFontFace;
type Run = { face: Face; text: string };
const files = new Map(manifest.fonts.map((f) => [f.file, f]));
const buffers = new Map<Face, Buffer>();
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const installed = new WeakSet<PDFKit.PDFDocument>();
// LF/CR brechen die Zeile (PDFKit/pdf-lib); TAB wird vorher zu einem Leerzeichen.
const lineControls = new Set([10, 13]);

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
/** An entire grapheme uses one face; combining marks must not be separated from their base.
 * TAB has no glyph in Noto Sans (a visible .notdef box) and is set as one space for every
 * user. `fallback: false` restricts the runs to Noto Sans, e.g. where the CJK face cannot
 * be embedded; graphemes it does not cover then fail like any other unsupported text. */
export function pdfFontRuns(
  text: string,
  bold = false,
  { fallback = true }: { fallback?: boolean } = {},
): Run[] {
  const preferred: Face = bold ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf';
  const faces: Face[] = fallback
    ? [preferred, bold ? 'NotoSansSC-Bold.otf' : 'NotoSansSC-Regular.otf']
    : [preferred];
  const result: Run[] = [];
  for (const { segment } of segmenter.segment(text.replace(/\t/g, ' '))) {
    const codepoints = [...segment].map((c) => c.codePointAt(0)!);
    const face = faces.find((font) => codepoints.every((cp) => covered(font, cp)));
    if (!face) throw new UnsupportedPdfTextError(codepoints);
    const last = result.at(-1);
    if (last?.face === face) last.text += segment;
    else result.push({ face, text: segment });
  }
  return result;
}
/** Hash-checked font file (manifest.json), also for PDF libraries other than PDFKit. */
export function pdfFontBytes(face: PdfFontFace): Buffer {
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
 * calls retain their weight; text and width measurement use embedded Noto faces with
 * checked fallback. This opt-in adapter does not change the other historical PDF generators. */
export function installUnicodePdfFonts(doc: PDFKit.PDFDocument): PDFKit.PDFDocument {
  if (installed.has(doc)) return doc;
  for (const face of files.keys() as IterableIterator<Face>)
    doc.registerFont(face, pdfFontBytes(face));
  const originalFont = doc.font.bind(doc);
  const originalText = doc.text.bind(doc);
  const originalWidth = doc.widthOfString.bind(doc);
  let bold = false;
  // Every face switch goes through `selectFace`, so a measurement can restore the exact face.
  let active: Face = 'NotoSans-Regular.ttf';
  const selectFace = (face: Face, size?: number) => {
    active = face;
    return size === undefined ? originalFont(face) : originalFont(face, size);
  };
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
    return selectFace(selected, typeof familyOrSize === 'number' ? familyOrSize : size);
  }) as typeof doc.font;
  // Width per run in its actual face: fallback glyphs (CJK, symbols) must not be measured
  // as .notdef of Noto Sans. PDFKit's own wrapping (text width, heightOfString) also
  // measures through this method, always within one run and its face.
  doc.widthOfString = ((value: string, options?: PDFKit.Mixins.TextOptions) => {
    let runs: Run[];
    try {
      runs = pdfFontRuns(String(value ?? ''), bold);
    } catch {
      return originalWidth(value, options); // Measuring never blocks; drawing checks the text.
    }
    if (runs.every((run) => run.face === active))
      return originalWidth(runs.map((run) => run.text).join(''), options);
    const previous = active;
    let width = 0;
    for (const run of runs) {
      selectFace(run.face);
      width += originalWidth(run.text, options);
    }
    selectFace(previous);
    return width;
  }) as typeof doc.widthOfString;
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
      selectFace(run.face);
      const runOptions = { ...opts, continued: i < runs.length - 1 || opts?.continued === true };
      if (i === 0 && typeof xOrOptions === 'number')
        originalText(run.text, xOrOptions, y, runOptions);
      else originalText(run.text, runOptions);
    }
    selectFace(bold ? 'NotoSans-Bold.ttf' : 'NotoSans-Regular.ttf');
    return doc;
  }) as typeof doc.text;
  selectFace('NotoSans-Regular.ttf');
  installed.add(doc);
  return doc;
}
