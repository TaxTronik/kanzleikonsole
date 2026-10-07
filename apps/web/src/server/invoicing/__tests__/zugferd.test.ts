// Fachkatalog: INV-ARCHIVE-EINVOICE-001
// Fachkatalog: INV-STORNO-REFERENCE-001
import { describe, it, expect } from 'vitest';
import { extractFacturXXml, generateZugferdPdf, UnsupportedInvoiceTextError } from '../zugferd';
import { generateXRechnungCii, type XRechnungBuyer, type XRechnungInvoice } from '../xrechnung';
import type { SellerInfo } from '@/server/settings/tenant-settings';
import type { LetterheadConfig } from '@/server/settings/letterhead';
import {
  SAMPLE_INVOICE,
  SAMPLE_SELLER,
  SAMPLE_BUYER,
  SAMPLE_STORNO_INVOICE,
} from '../sample-fixture';
import { extractText, getDocumentProxy } from 'unpdf';
import { UnsupportedPdfTextError } from '@/server/documents/pdf-fonts';

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
    // BEWUSST kein PDF/A-3-Anspruch (kein OutputIntent/ICC) — die
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

describe('generateZugferdPdf — eingebettete Unicode-Schriften (F-02)', () => {
  const NAMES = ['Yıldız Bau GmbH', 'Şahin', 'Łódź', 'Dvořák', 'Müller', 'Çelik'];
  // Synthetische Stammdaten; jeder Name steht an einer anderen gezeichneten Stelle.
  const buyer = { ...SAMPLE_BUYER, name: 'Yıldız Bau GmbH', street: 'Şahin Sokak 3', city: 'Łódź' };
  const seller = { ...SAMPLE_SELLER, name: 'Kanzlei Dvořák', bankName: 'Bank Müller' };

  it.each([
    ['Rechnung', SAMPLE_INVOICE],
    ['Storno', SAMPLE_STORNO_INVOICE],
  ])('setzt Namen außerhalb von WinAnsi in der %s-PDF', async (_kind, base) => {
    const invoice = {
      ...base,
      positions: base.positions.map((p) => ({ ...p, description: `${p.description} für Çelik` })),
    };
    const cii = generateXRechnungCii(invoice, seller, buyer);
    const pdfBytes = await generateZugferdPdf(invoice, seller, buyer, cii);
    await expect(extractFacturXXml(pdfBytes)).resolves.toEqual(Buffer.from(cii, 'utf8'));
    const { text } = await extractText(await getDocumentProxy(pdfBytes), { mergePages: true });
    for (const name of NAMES) expect(text, name).toContain(name);
    expect(text).toContain(`Rechnung ${invoice.number}`);
  });

  it('sperrt Emoji und nur von der CJK-Ersatzschrift abgedeckte Zeichen ausdrücklich', async () => {
    for (const [name, codepoint] of [
      ['Yıldız Bau GmbH 😀', 'U+1F600'],
      ['李明 GmbH', 'U+674E'],
    ] as const) {
      const unsupported = { ...SAMPLE_BUYER, name };
      const cii = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, unsupported);
      const pending = generateZugferdPdf(SAMPLE_INVOICE, SAMPLE_SELLER, unsupported, cii);
      await expect(pending).rejects.toThrow(UnsupportedPdfTextError);
      await expect(pending).rejects.toThrow(codepoint);
    }
  });
});

describe('generateZugferdPdf — Ablehnung nennt Zeichen und Feld (C5)', () => {
  const E = '😀';
  const NO_LETTERHEAD: LetterheadConfig = {
    organisationName: '',
    addressLines: '',
    contactLine: '',
    footnote: '',
  };
  const MESSAGE_END =
    'mit der eingebetteten PDF-Schrift nicht darstellbar (Feld: Mandant – Name). ' +
    'Zeichen werden nicht still ersetzt; bitte die betroffenen Angaben prüfen.';

  interface Change {
    invoice?: Partial<XRechnungInvoice>;
    position?: Partial<XRechnungInvoice['positions'][number]>;
    seller?: Partial<SellerInfo>;
    buyer?: Partial<XRechnungBuyer>;
    letterhead?: Partial<LetterheadConfig>;
  }

  function render(change: Change, base: XRechnungInvoice = SAMPLE_INVOICE) {
    const invoice = {
      ...base,
      ...change.invoice,
      positions: base.positions.map((p, i) => (i === 0 ? { ...p, ...change.position } : p)),
    };
    const letterhead = change.letterhead ? { ...NO_LETTERHEAD, ...change.letterhead } : null;
    return generateZugferdPdf(
      invoice,
      { ...SAMPLE_SELLER, ...change.seller },
      { ...SAMPLE_BUYER, ...change.buyer },
      '<cii/>',
      { letterhead },
    );
  }

  /** Die Vorabprüfung (nicht erst das Zeichnen) muss die Rechnung abweisen. */
  async function rejection(change: Change, base?: XRechnungInvoice) {
    const error = await render(change, base).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsupportedInvoiceTextError);
    expect(error).toBeInstanceOf(UnsupportedPdfTextError);
    return error as UnsupportedInvoiceTextError;
  }

  it.each([
    ['Rechnung', SAMPLE_INVOICE],
    ['Storno', SAMPLE_STORNO_INVOICE],
  ])('nennt in der %s jedes betroffene Zeichen einmal mit Feld', async (_kind, base) => {
    const error = await rejection({ buyer: { name: '李明 GmbH 李' } }, base);
    expect(error.findings).toEqual([{ field: 'Mandant – Name', characters: ['李', '明'] }]);
    expect(error.message).toBe(`Die Zeichen „李“ (U+674E), „明“ (U+660E) sind ${MESSAGE_END}`);
  });

  it('fasst mehrere Felder zusammen und zählt jedes Zeichen nur einmal', async () => {
    const error = await rejection({
      buyer: { name: `Mandant ${E} AG` },
      invoice: { notes: 'Rückfragen an 李' },
      position: { description: `Beratung ${E} 李 👍🏽` },
    });
    expect(error.findings).toEqual([
      { field: 'Mandant – Name', characters: [E] },
      { field: 'Position 1 – Beschreibung', characters: [E, '李', '👍🏽'] },
      { field: 'Notizen', characters: ['李'] },
    ]);
    expect(error.message).toBe(
      'Die Zeichen „😀“ (U+1F600), „李“ (U+674E), „👍🏽“ (U+1F44D U+1F3FD) sind mit der ' +
        'eingebetteten PDF-Schrift nicht darstellbar (Felder: Mandant – Name, ' +
        'Position 1 – Beschreibung, Notizen). Zeichen werden nicht still ersetzt; bitte ' +
        'die betroffenen Angaben prüfen.',
    );
  });

  it('begrenzt die Liste auf zehn Zeichen und kürzt den Rest mit „…“', async () => {
    const characters = [...'一二三四五六七八九十百千'];
    const error = await rejection({ invoice: { subject: characters.join(' ') } });
    expect(error.findings).toEqual([{ field: 'Betreff', characters }]);
    expect(error.message).toContain('„九“ (U+4E5D), „十“ (U+5341), … sind mit der');
    expect(error.message).not.toContain('百');
    expect(error.message).toContain('(Feld: Betreff)');
  });

  it('nennt unsichtbare Zeichen nur mit Codepunkt', async () => {
    const error = await rejection({ position: { unit: 'Std.\u{E000}' } });
    expect(error.message).toBe(
      'Das Zeichen U+E000 ist mit der eingebetteten PDF-Schrift nicht darstellbar ' +
        '(Feld: Position 1 – Einheit). Zeichen werden nicht still ersetzt; bitte die ' +
        'betroffenen Angaben prüfen.',
    );
  });

  // Jedes aus Daten gezeichnete Feld: Ein Treffer erst beim Zeichnen wäre ein
  // einfacher UnsupportedPdfTextError ohne Feld und ließe rejection() scheitern.
  it.each<[string, Change]>([
    ['Kanzlei-Stammdaten – Kanzlei-Name', { seller: { name: `Kanzlei ${E}` } }],
    ['Briefkopf – Kanzlei-Name', { letterhead: { organisationName: `Kanzlei ${E}` } }],
    ['Kanzlei-Stammdaten – Anschrift', { seller: { street: `Weg ${E}` } }],
    [
      'Kanzlei-Stammdaten – Anschrift',
      { seller: { city: `Ort ${E}` }, letterhead: { addressLines: 'Weg 1\n10115 Berlin' } },
    ],
    ['Briefkopf – Adresse', { letterhead: { addressLines: `Weg 1\nOrt ${E}` } }],
    ['Kanzlei-Stammdaten – Telefon/E-Mail', { seller: { phone: `030 ${E}` } }],
    ['Briefkopf – Kontakt-Zeile', { letterhead: { contactLine: `Tel. ${E}` } }],
    ['Briefkopf – Fußnote', { letterhead: { footnote: `Kammer ${E}` } }],
    ['Mandant – Name', { buyer: { name: `Mandant ${E}` } }],
    ['Mandant – Straße', { buyer: { street: `Gasse ${E}` } }],
    ['Mandant – PLZ/Ort', { buyer: { city: `Ort ${E}` } }],
    ['Mandant – Land', { buyer: { countryIso: `A${E}` } }],
    ['Rechnungsnummer', { invoice: { number: `R-${E}` } }],
    ['Kanzlei-Stammdaten – USt-ID', { seller: { vatId: `DE${E}` } }],
    ['Kanzlei-Stammdaten – Steuernummer', { seller: { vatId: null, taxNumber: `12/${E}` } }],
    ['Betreff', { invoice: { subject: `Betreff ${E}` } }],
    ['Position 1 – Einheit', { position: { unit: `Std. ${E}` } }],
    ['Position 1 – Beschreibung', { position: { description: `Beratung\n${E}` } }],
    ['Notizen', { invoice: { notes: `Hinweis ${E}` } }],
    ['Kanzlei-Stammdaten – Bankname', { seller: { bankName: `Bank ${E}` } }],
    ['Kanzlei-Stammdaten – IBAN', { seller: { iban: `DE89 ${E}` } }],
    ['Kanzlei-Stammdaten – BIC', { seller: { bic: `COBA ${E}` } }],
  ])('weist %s vor dem Zeichnen mit Feldangabe ab', async (field, change) => {
    const error = await rejection(change);
    expect(error.findings).toEqual([{ field, characters: [E] }]);
  });

  it('prüft nur tatsächlich gezeichnete Angaben', async () => {
    // Der Briefkopfname ersetzt den Stammdatennamen im PDF, Adresszeilen ab der
    // siebten entfallen, Leerraum in Beschreibungen wird zu einfachen Leerzeichen.
    const bytes = await render({
      seller: { name: `Kanzlei ${E}` },
      letterhead: {
        organisationName: 'Briefkopf-Kanzlei',
        addressLines: ['1', '2', '3', '4', '5', '6', `7 ${E}`].join('\n'),
      },
      position: { description: 'Beratung　Steuer' },
    });
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
    expect(text).toContain('Briefkopf-Kanzlei');
    expect(text).toContain('Beratung Steuer');
  });
});
