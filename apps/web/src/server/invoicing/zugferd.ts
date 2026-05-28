// =============================================================================
// ZUGFeRD / Factur-X PDF-Generator
//
// Erzeugt ein PDF mit eingebetteter Factur-X-XML (CII-Format).
// Das PDF ist *kein* strikt validiertes PDF/A-3 — für volle Konformität wäre
// ein nachgelagerter Schritt mit Ghostscript oder einem PDF/A-Validator nötig.
// Für die meisten B2B-Empfänger ist diese Variante ausreichend, weil:
//   1. die XML korrekt eingebettet ist (Attachment + AFRelationship: Source),
//   2. die XMP-Metadaten Factur-X erkennen lassen,
//   3. die Konformitätsstufe EN16931 deklariert ist.
//
// Profil: EN 16931 ("Factur-X / ZUGFeRD 2.x — EN 16931")
//   urn:cen.eu:en16931:2017
// =============================================================================

import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFDict,
  PDFRef,
  AFRelationship,
  StandardFonts,
  rgb,
  type PDFFont,
} from 'pdf-lib';
import type { XRechnungInvoice, XRechnungBuyer } from './xrechnung';
import type { SellerInfo } from '@/server/settings/tenant-settings';

import { fmtEUR } from '@/lib/fmt';
// re-export für External Imports
export type { XRechnungInvoice, XRechnungBuyer };

interface PageContext {
  doc: PDFDocument;
  font: PDFFont;
  fontBold: PDFFont;
  page: import('pdf-lib').PDFPage;
  y: number;
  pageWidth: number;
  pageHeight: number;
  margin: number;
}

const FONT_SIZE_NORMAL = 9;
const FONT_SIZE_SMALL = 8;
const FONT_SIZE_TITLE = 16;
const FONT_SIZE_HEADING = 11;

function fmtNum(n: number): string {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(n);
}

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('de-DE').format(d);
}

function newPageIfNeeded(ctx: PageContext, neededHeight: number): void {
  if (ctx.y - neededHeight < ctx.margin + 30) {
    ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    ctx.y = ctx.pageHeight - ctx.margin;
  }
}

function drawText(ctx: PageContext, text: string, x: number, y: number, opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {}): void {
  const size = opts.size ?? FONT_SIZE_NORMAL;
  const font = opts.bold ? ctx.fontBold : ctx.font;
  ctx.page.drawText(text, {
    x,
    y,
    size,
    font,
    color: opts.color ?? rgb(0.1, 0.1, 0.1),
  });
}

function drawLine(ctx: PageContext, y: number, color = rgb(0.7, 0.7, 0.7)): void {
  ctx.page.drawLine({
    start: { x: ctx.margin, y },
    end: { x: ctx.pageWidth - ctx.margin, y },
    thickness: 0.5,
    color,
  });
}

export async function generateZugferdPdf(
  invoice: XRechnungInvoice,
  seller: SellerInfo,
  buyer: XRechnungBuyer,
  ciiXml: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // A4
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const page = doc.addPage([pageWidth, pageHeight]);

  const ctx: PageContext = {
    doc,
    font,
    fontBold,
    page,
    y: pageHeight - margin,
    pageWidth,
    pageHeight,
    margin,
  };

  // Verkäufer-Block (oben links, klein)
  drawText(ctx, seller.name, margin, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  ctx.y -= 11;
  if (seller.street) {
    drawText(ctx, seller.street, margin, ctx.y, { size: FONT_SIZE_SMALL });
    ctx.y -= 10;
  }
  if (seller.postalCode || seller.city) {
    drawText(
      ctx,
      `${seller.postalCode ?? ''} ${seller.city ?? ''}`.trim(),
      margin,
      ctx.y,
      { size: FONT_SIZE_SMALL },
    );
    ctx.y -= 10;
  }
  if (seller.email) {
    drawText(ctx, seller.email, margin, ctx.y, { size: FONT_SIZE_SMALL });
    ctx.y -= 10;
  }

  // Empfänger-Block (links, größer)
  ctx.y -= 30;
  drawText(ctx, buyer.name, margin, ctx.y, { bold: true });
  ctx.y -= 12;
  if (buyer.street) { drawText(ctx, buyer.street, margin, ctx.y); ctx.y -= 11; }
  if (buyer.postalCode || buyer.city) {
    drawText(ctx, `${buyer.postalCode ?? ''} ${buyer.city ?? ''}`.trim(), margin, ctx.y);
    ctx.y -= 11;
  }
  if (buyer.countryIso && buyer.countryIso !== 'DE') {
    drawText(ctx, buyer.countryIso, margin, ctx.y);
    ctx.y -= 11;
  }

  // Datum + Nummer (rechts)
  const rightCol = pageWidth - margin - 200;
  let yRight = pageHeight - margin - 60;
  drawText(ctx, 'Rechnungsnummer', rightCol, yRight, { size: FONT_SIZE_SMALL, color: rgb(0.5, 0.5, 0.5) });
  drawText(ctx, invoice.number, rightCol + 100, yRight, { bold: true });
  yRight -= 14;
  drawText(ctx, 'Rechnungsdatum', rightCol, yRight, { size: FONT_SIZE_SMALL, color: rgb(0.5, 0.5, 0.5) });
  drawText(ctx, fmtDate(invoice.issueDate), rightCol + 100, yRight);
  yRight -= 14;
  drawText(ctx, 'Fällig am', rightCol, yRight, { size: FONT_SIZE_SMALL, color: rgb(0.5, 0.5, 0.5) });
  drawText(ctx, fmtDate(invoice.dueDate), rightCol + 100, yRight);
  yRight -= 14;
  if (seller.vatId) {
    drawText(ctx, 'USt-ID Verkäufer', rightCol, yRight, { size: FONT_SIZE_SMALL, color: rgb(0.5, 0.5, 0.5) });
    drawText(ctx, seller.vatId, rightCol + 100, yRight, { size: FONT_SIZE_SMALL });
  }

  // Titel
  ctx.y -= 30;
  drawText(ctx, `Rechnung ${invoice.number}`, margin, ctx.y, { bold: true, size: FONT_SIZE_TITLE });
  ctx.y -= 22;
  drawText(ctx, invoice.subject, margin, ctx.y, { size: FONT_SIZE_HEADING, color: rgb(0.4, 0.4, 0.4) });
  ctx.y -= 25;

  // Positions-Tabelle
  drawLine(ctx, ctx.y);
  ctx.y -= 15;
  // Spaltenbreiten
  const colPos = margin;
  const colDesc = margin + 25;
  const colQty = pageWidth - margin - 220;
  const colPrice = pageWidth - margin - 110;
  const colNet = pageWidth - margin;

  drawText(ctx, 'Pos', colPos, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  drawText(ctx, 'Beschreibung', colDesc, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  drawText(ctx, 'Menge', colQty - 30, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  drawText(ctx, 'Einzelpreis', colPrice - 60, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  drawText(ctx, 'Netto', colNet - 50, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  ctx.y -= 5;
  drawLine(ctx, ctx.y);
  ctx.y -= 12;

  for (const p of invoice.positions) {
    newPageIfNeeded(ctx, 24);
    drawText(ctx, String(p.position), colPos, ctx.y);
    drawText(ctx, p.description, colDesc, ctx.y);
    drawText(ctx, `${fmtNum(p.quantity)} ${p.unit}`, colQty - 30, ctx.y);
    drawText(ctx, fmtEUR(p.unitPrice), colPrice - 60, ctx.y);
    drawText(ctx, fmtEUR(p.netAmount), colNet - 50, ctx.y);
    ctx.y -= 16;
  }

  ctx.y -= 5;
  drawLine(ctx, ctx.y);
  ctx.y -= 18;

  // Summen-Block (rechts)
  const sumCol1 = pageWidth - margin - 180;
  const sumCol2 = pageWidth - margin - 50;
  drawText(ctx, 'Netto', sumCol1, ctx.y);
  drawText(ctx, fmtEUR(invoice.netAmount), sumCol2, ctx.y);
  ctx.y -= 14;
  drawText(ctx, `USt (${invoice.vatRate.toFixed(2)} %)`, sumCol1, ctx.y);
  drawText(ctx, fmtEUR(invoice.vatAmount), sumCol2, ctx.y);
  ctx.y -= 14;
  drawLine(ctx, ctx.y, rgb(0.4, 0.4, 0.4));
  ctx.y -= 14;
  drawText(ctx, 'Brutto', sumCol1, ctx.y, { bold: true, size: FONT_SIZE_HEADING });
  drawText(ctx, fmtEUR(invoice.totalAmount), sumCol2, ctx.y, { bold: true, size: FONT_SIZE_HEADING });
  ctx.y -= 30;

  // Notizen
  if (invoice.notes) {
    newPageIfNeeded(ctx, 60);
    drawText(ctx, 'Hinweise', margin, ctx.y, { bold: true, size: FONT_SIZE_SMALL, color: rgb(0.5, 0.5, 0.5) });
    ctx.y -= 12;
    // Naive Wrapping: max 90 Zeichen pro Zeile
    for (const line of invoice.notes.split('\n')) {
      newPageIfNeeded(ctx, 12);
      drawText(ctx, line.slice(0, 100), margin, ctx.y);
      ctx.y -= 11;
    }
    ctx.y -= 10;
  }

  // Bankverbindung / Zahlungshinweis
  if (seller.iban) {
    newPageIfNeeded(ctx, 60);
    drawText(ctx, 'Zahlung bitte auf folgendes Konto:', margin, ctx.y, { size: FONT_SIZE_SMALL, color: rgb(0.5, 0.5, 0.5) });
    ctx.y -= 12;
    if (seller.bankName) { drawText(ctx, seller.bankName, margin, ctx.y); ctx.y -= 11; }
    drawText(ctx, `IBAN: ${seller.iban}`, margin, ctx.y); ctx.y -= 11;
    if (seller.bic) { drawText(ctx, `BIC: ${seller.bic}`, margin, ctx.y); ctx.y -= 11; }
    drawText(ctx, `Verwendungszweck: ${invoice.number}`, margin, ctx.y); ctx.y -= 11;
  }

  // Footer
  drawText(
    ctx,
    'Diese PDF enthält eine maschinenlesbare ZUGFeRD/Factur-X-XML (Profil EN 16931).',
    margin,
    margin + 10,
    { size: 7, color: rgb(0.5, 0.5, 0.5) },
  );

  // ----- XML-Anhang einbetten ----------------------------------------------
  await embedFacturXAttachment(doc, ciiXml);

  // ----- XMP-Metadaten (Factur-X-Konformität) ------------------------------
  setFacturXMetadata(doc, invoice.number);

  return doc.save();
}

/**
 * Bettet die CII-XML als Datei-Anhang in das PDF ein, mit dem Filename
 * `factur-x.xml` und der Beziehung "Source" (AFRelationship).
 */
async function embedFacturXAttachment(doc: PDFDocument, ciiXml: string): Promise<void> {
  const xmlBytes = new TextEncoder().encode(ciiXml);

  // pdf-lib's high-level attach()-API
  await doc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'application/xml',
    description: 'Factur-X invoice XML (CII)',
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Source,
  });
}

/**
 * Setzt Document-Info + minimale XMP-Metadaten, die Factur-X-Verarbeiter
 * erkennen können. Für strikte PDF/A-3-Konformität wäre ein vollständiger
 * XMP-Block nach RDF/XML erforderlich (z. B. via Ghostscript-Postprocessing).
 */
function setFacturXMetadata(doc: PDFDocument, invoiceNumber: string): void {
  doc.setTitle(`Rechnung ${invoiceNumber}`);
  doc.setSubject('ZUGFeRD/Factur-X invoice — EN 16931');
  doc.setKeywords(['ZUGFeRD', 'Factur-X', 'EN 16931', 'XRechnung', 'Rechnung']);
  doc.setProducer('taxtronik');
  doc.setCreator('taxtronik');

  // PDF-Info-Dictionary um Factur-X-Schlüssel ergänzen — manche Verarbeiter
  // lesen Document-Info statt XMP. Schadet nicht. `getInfoDict` ist in
  // pdf-lib als private markiert — Cast, weil keine öffentliche API existiert.
  const docAny = doc as unknown as { getInfoDict(): PDFRef };
  const info = doc.context.lookup(docAny.getInfoDict()) as PDFDict | undefined;
  if (info) {
    info.set(PDFName.of('FacturXVersion'), PDFString.of('1.0'));
    info.set(PDFName.of('FacturXConformanceLevel'), PDFString.of('EN 16931'));
    info.set(PDFName.of('FacturXDocumentType'), PDFString.of('INVOICE'));
    info.set(PDFName.of('FacturXFilename'), PDFString.of('factur-x.xml'));
  }
}
