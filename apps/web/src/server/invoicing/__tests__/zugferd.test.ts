import { describe, it, expect } from 'vitest';
import { extractFacturXXml, generateZugferdPdf } from '../zugferd';
import { generateXRechnungCii } from '../xrechnung';
import { SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER } from '../sample-fixture';
import { extractText, getDocumentProxy } from 'unpdf';

describe('generateZugferdPdf — Factur-X-Hybrid (iter/P2-8)', () => {
  it('INV-ARCHIVE-EINVOICE-001: preserves long multi-page descriptions inside their column', async () => {
    const description = Array.from(
      { length: 80 },
      (_, index) =>
        `Nachweis ${index + 1}: vollständige Leistungsbeschreibung https://example.test/eine-besonders-lange-ungestueckte-quellenadresse-${index}`,
    ).join('\n');
    const invoice = {
      ...SAMPLE_INVOICE,
      positions: [{ ...SAMPLE_INVOICE.positions[0]!, description }],
    };
    const xml = generateXRechnungCii(invoice, SAMPLE_SELLER, SAMPLE_BUYER);
    const bytes = await generateZugferdPdf(invoice, SAMPLE_SELLER, SAMPLE_BUYER, xml);
    const pdf = await getDocumentProxy(bytes);
    expect(pdf.numPages).toBeGreaterThan(1);
    const { text } = await extractText(pdf, { mergePages: true });
    // Headers and page footers may occur between description lines.
    for (let index = 1; index <= 80; index++) expect(text).toContain(`Nachweis ${index}:`);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || item.transform[4] !== 75) continue;
        // The adjacent quantity column begins at x = 295; pdf.js and
        // pdf-lib differ slightly in kerning/width measurement.
        expect(item.transform[4] + item.width).toBeLessThan(295);
        expect(item.transform[5]).toBeGreaterThan(60);
      }
    }
  });

  it('bettet die XML als „Alternative" ein und trägt den Factur-X-XMP-Block', async () => {
    const cii = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
    const pdfBytes = await generateZugferdPdf(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER, cii);
    const raw = Buffer.from(pdfBytes).toString('latin1');

    // Gültiges PDF.
    expect(raw.startsWith('%PDF-')).toBe(true);
    // Factur-X-XMP-Metadatenstrom (Stream-Objekt, unkomprimiert): Namespace +
    // Kernfelder, an denen konforme Verarbeiter das Hybrid erkennen.
    expect(raw).toContain('urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#');
    expect(raw).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    expect(raw).toContain('<fx:DocumentType>INVOICE</fx:DocumentType>');
    expect(raw).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    // BEWUSST kein PDF/A-3-Anspruch (nicht eingebettete Standard-Fonts) — die
    // XMP darf kein pdfaid:part behaupten.
    expect(raw).not.toContain('pdfaid:part');
  });

  it('druckt Briefkopf-Absender und Fußnote in die menschenlesbare Rechnung', async () => {
    const cii = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
    const pdfBytes = await generateZugferdPdf(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER, cii, {
      logoDataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      letterhead: {
        organisationName: 'Kanzlei am Testplatz',
        addressLines: 'Briefkopfweg 7\n10117 Berlin',
        contactLine: 'Telefon 030 123 · briefkopf@example.test',
        footnote: 'Steuerberaterkammer Berlin · Register 4711',
      },
    });
    // pdf.js darf den übergebenen ArrayBuffer übernehmen/detachen; die rohe
    // Attachment-Prüfung deshalb vorher durchführen.
    const raw = Buffer.from(pdfBytes).toString('latin1');
    expect(raw).toContain('factur-x.xml');
    expect(raw).toContain('/Subtype /Image');
    const pdf = await getDocumentProxy(pdfBytes);
    const { text } = await extractText(pdf, { mergePages: true });

    expect(text).toContain('Kanzlei am Testplatz');
    expect(text).toContain('Briefkopfweg 7');
    expect(text).toContain('Telefon 030 123');
    expect(text).toContain('Steuerberaterkammer Berlin');
  });

  it('extrahiert für Legacy-Reparaturen exakt die eingebettete Factur-X-XML', async () => {
    const cii = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
    const pdfBytes = await generateZugferdPdf(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER, cii);

    await expect(extractFacturXXml(pdfBytes)).resolves.toEqual(Buffer.from(cii, 'utf8'));
  });
});
