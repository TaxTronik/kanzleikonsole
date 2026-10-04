// Fachkatalog: CLIENT-ASSISTANCE-001
// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: CLIENT-OFFBOARDING-001
// Fachkatalog: PAYROLL-INTAKE-001
import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import { extractText } from 'unpdf';
import { installUnicodePdfFonts, pdfFontRuns, UnsupportedPdfTextError } from '../pdf-fonts';
const sample = 'Jörg Weiß · İpek Şahin · Łukasz Żółć · Nguyễn An · 李明';

describe('embedded PDF font coverage and lossless names', () => {
  it('keeps complete graphemes and original codepoints across regular and bold fallbacks', () => {
    for (const bold of [false, true]) {
      const text = sample + '\nA\u0308nne\t1.234,56 €';
      const runs = pdfFontRuns(text, bold);
      // TAB has no Noto glyph and becomes one space; everything else stays unchanged.
      expect(runs.map((r) => r.text).join('')).toBe(text.replace('\t', ' '));
      expect(runs.some((r) => r.face.includes('NotoSansSC'))).toBe(true);
      expect(runs.some((r) => r.face.includes('NotoSans-'))).toBe(true);
      expect(runs.every((r) => r.face.includes(bold ? 'Bold' : 'Regular'))).toBe(true);
    }
  });
  it('fails closed for unsupported emoji and scripts instead of silently corrupting names', () => {
    expect(() => pdfFontRuns('Name 😀')).toThrow(UnsupportedPdfTextError);
    expect(() => pdfFontRuns('Name 😀')).toThrow('U+1F600');
    expect(() => pdfFontRuns('مرحبا')).toThrow(UnsupportedPdfTextError);
    // Without the CJK fallback (pdf-lib cannot subset it), CJK fails the same way.
    expect(() => pdfFontRuns('李明', false, { fallback: false })).toThrow('U+674E');
    expect(pdfFontRuns('Yıldız Dvořák', true, { fallback: false })).toEqual([
      { face: 'NotoSans-Bold.ttf', text: 'Yıldız Dvořák' },
    ]);
  });
  it('measures fallback runs in their own face, keeps the active face and sets TAB as space', async () => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (b) => chunks.push(b));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    installUnicodePdfFonts(doc);
    doc.font('Helvetica').fontSize(10);
    const latin = doc.widthOfString('Müller');
    // Two full-width Noto Sans SC glyphs, not 2 × .notdef of Noto Sans (12 pt).
    expect(doc.widthOfString('李明')).toBeCloseTo(20, 5);
    expect(doc.widthOfString('Müller李明')).toBeCloseTo(latin + 20, 5);
    expect(doc.widthOfString('Müller')).toBe(latin);
    // 60 × 10 pt in 450 pt wraps to two lines (measured as .notdef: 360 pt, one line).
    const line = doc.heightOfString('李', { width: 450 });
    expect(doc.heightOfString('李'.repeat(60), { width: 450 })).toBeCloseTo(2 * line, 5);
    doc.text('Spalte\tWert Müller');
    doc.end();
    const result = await extractText(new Uint8Array(await bytes), { mergePages: true });
    expect(result.text).toContain('Spalte Wert Müller');
    expect(result.text).not.toContain('\u0000');
  });
  it('embeds Unicode fonts and preserves all names through actual PDF extraction and page wraps', async () => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (b) => chunks.push(b));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    installUnicodePdfFonts(doc);
    installUnicodePdfFonts(doc);
    doc.font('Helvetica-Bold').fontSize(16).text(sample);
    doc
      .font('Helvetica')
      .fontSize(10)
      .text((sample + ' Nachvollziehbare synthetische Belegbearbeitung.\n').repeat(90));
    doc.text('ENDE DER UNICODE-PRÜFUNG');
    doc.end();
    const result = await extractText(new Uint8Array(await bytes), { mergePages: true });
    expect(result.totalPages).toBeGreaterThan(1);
    for (const name of ['Jörg Weiß', 'İpek Şahin', 'Łukasz Żółć', 'Nguyễn An', '李明'])
      expect(result.text).toContain(name);
    expect(result.text).toContain('ENDE DER UNICODE-PRÜFUNG');
    expect(result.text.match(/李明/g)).toHaveLength(91);
  });
});
