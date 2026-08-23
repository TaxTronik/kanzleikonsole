// =============================================================================
// ZUGFeRD / Factur-X PDF-Generator
//
// Erzeugt ein PDF mit eingebetteter Factur-X-XML (CII-Format).
// Das PDF ist *kein* strikt validiertes PDF/A-3 — für volle Konformität wäre
// ein nachgelagerter Schritt mit Ghostscript oder einem PDF/A-Validator nötig.
// Für die meisten B2B-Empfänger ist diese Variante ausreichend, weil:
//   1. die XML korrekt eingebettet ist (Attachment + AFRelationship: Alternative),
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
  PDFArray,
  PDFHexString,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  PDFRef,
  AFRelationship,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
} from 'pdf-lib';
import type { XRechnungInvoice, XRechnungBuyer } from './xrechnung';
import { computeVatTotals } from './vat';
import type { SellerInfo } from '@/server/settings/tenant-settings';
import type { LetterheadConfig } from '@/server/settings/letterhead';

import { fmtDateShort, fmtDecimal, fmtEUR } from '@/lib/fmt';
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
  contentBottom: number;
}

export interface InvoicePdfPresentation {
  /** Helles Kanzlei-Logo aus den Branding-Einstellungen. */
  logoDataUrl?: string | null;
  /** Optionaler Briefkopf; leere Felder fallen auf die Rechnungs-Absenderdaten zurück. */
  letterhead?: LetterheadConfig | null;
}

interface LetterheadLayout {
  senderName: string;
  addressLines: string[];
  contactLines: string[];
  footerDetailLines: string[];
  footerMachineY: number;
  footerDetailsY: number;
  footerSellerY: number;
  footerRuleY: number;
  footerSellerLine: string;
}

const FONT_SIZE_NORMAL = 9;
const FONT_SIZE_SMALL = 8;
const FONT_SIZE_TITLE = 16;
const FONT_SIZE_HEADING = 11;

function fmtNum(n: number): string {
  return fmtDecimal(n);
}

function fmtDate(d: Date): string {
  return fmtDateShort(d);
}

/** Bricht Text an Wortgrenzen in Zeilen mit höchstens `maxChars` Zeichen. Ein
 *  einzelnes überlanges Wort wird hart geteilt (statt es abzuschneiden). */
function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (word.length > maxChars) {
      if (line) {
        out.push(line);
        line = '';
      }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars) {
      out.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

function wrapMultiline(text: string, maxChars: number, maxLines: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .flatMap((line) => wrapText(line.trim(), maxChars))
    .filter((line) => line.length > 0);
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  const last = visible[maxLines - 1] ?? '';
  visible[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  return visible;
}

function buildLetterheadLayout(
  letterhead: LetterheadConfig | null | undefined,
  seller: SellerInfo,
): LetterheadLayout {
  const senderName = letterhead?.organisationName.trim() || seller.name;
  const configuredAddress = letterhead?.addressLines.trim() ?? '';
  const addressLines = configuredAddress
    ? wrapMultiline(configuredAddress, 52, 6)
    : [seller.street, `${seller.postalCode ?? ''} ${seller.city ?? ''}`.trim()].filter(
        (line): line is string => Boolean(line),
      );
  const configuredContact = letterhead?.contactLine.trim() ?? '';
  const contactLine = configuredContact || [seller.phone, seller.email].filter(Boolean).join(' · ');
  const configuredFootnote = letterhead?.footnote.trim() ?? '';
  const footerDetailLines = configuredFootnote ? wrapMultiline(configuredFootnote, 105, 8) : [];
  const footerMachineY = 18;
  const footerDetailsY = footerMachineY + 11;
  const footerSellerY = footerDetailsY + footerDetailLines.length * 8 + 3;
  const footerRuleY = footerSellerY + 11;
  const sellerLocation = `${seller.postalCode ?? ''} ${seller.city ?? ''}`.trim();
  const footerSellerLine = [senderName, sellerLocation].filter(Boolean).join(' · ');

  return {
    senderName,
    addressLines,
    contactLines: wrapMultiline(contactLine, 52, 3),
    footerDetailLines,
    footerMachineY,
    footerDetailsY,
    footerSellerY,
    footerRuleY,
    footerSellerLine,
  };
}

function drawLetterheadSender(ctx: PageContext, layout: LetterheadLayout): void {
  drawText(ctx, layout.senderName, ctx.margin, ctx.y, { bold: true, size: FONT_SIZE_SMALL });
  ctx.y -= 11;
  for (const line of layout.addressLines) {
    drawText(ctx, line, ctx.margin, ctx.y, { size: FONT_SIZE_SMALL });
    ctx.y -= 10;
  }
  for (const line of layout.contactLines) {
    drawText(ctx, line, ctx.margin, ctx.y, { size: FONT_SIZE_SMALL });
    ctx.y -= 10;
  }
}

function drawLetterheadFooterDetails(
  page: import('pdf-lib').PDFPage,
  layout: LetterheadLayout,
  font: PDFFont,
  margin: number,
): void {
  layout.footerDetailLines.forEach((line, lineIndex) => {
    page.drawText(line, {
      x: margin,
      y: layout.footerDetailsY + (layout.footerDetailLines.length - lineIndex - 1) * 8,
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  });
}

function newPageIfNeeded(ctx: PageContext, neededHeight: number): void {
  if (ctx.y - neededHeight < ctx.contentBottom) {
    ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    ctx.y = ctx.pageHeight - ctx.margin;
  }
}

function drawText(
  ctx: PageContext,
  text: string,
  x: number,
  y: number,
  opts: { bold?: boolean; size?: number; color?: ReturnType<typeof rgb> } = {},
): void {
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
  presentation: InvoicePdfPresentation = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Optional: Kanzlei-Logo (PNG/JPEG aus dem Tenant-Branding). WebP wird von
  // pdf-lib nicht unterstützt → dann kein Logo statt eines Fehlers.
  let logoImg: PDFImage | null = null;
  if (presentation.logoDataUrl) {
    try {
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(presentation.logoDataUrl);
      if (m) {
        const bytes = Buffer.from(m[2]!, 'base64');
        const isPng = m[1]!.toLowerCase() === 'png';
        logoImg = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      }
    } catch {
      logoImg = null;
    }
  }

  // A4
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const letterheadLayout = buildLetterheadLayout(presentation.letterhead, seller);
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
    contentBottom: letterheadLayout.footerRuleY + 15,
  };

  // Briefkopf/Verkäufer-Block (oben links, klein). Der Briefkopf beeinflusst
  // ausschließlich die menschenlesbare PDF-Darstellung; die strukturierten
  // Rechnungs-Absenderdaten in der eingebetteten XML bleiben SellerInfo.
  if (logoImg) {
    const scale = Math.min(40 / logoImg.height, 180 / logoImg.width);
    const logoH = logoImg.height * scale;
    const logoW = logoImg.width * scale;
    ctx.page.drawImage(logoImg, { x: margin, y: ctx.y - logoH, width: logoW, height: logoH });
    ctx.y -= logoH + 6;
  }
  drawLetterheadSender(ctx, letterheadLayout);

  // Empfänger-Block (links, größer)
  ctx.y -= 30;
  drawText(ctx, buyer.name, margin, ctx.y, { bold: true });
  ctx.y -= 12;
  if (buyer.street) {
    drawText(ctx, buyer.street, margin, ctx.y);
    ctx.y -= 11;
  }
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
  drawText(ctx, 'Rechnungsnummer', rightCol, yRight, {
    size: FONT_SIZE_SMALL,
    color: rgb(0.5, 0.5, 0.5),
  });
  drawText(ctx, invoice.number, rightCol + 100, yRight, { bold: true });
  yRight -= 14;
  drawText(ctx, 'Rechnungsdatum', rightCol, yRight, {
    size: FONT_SIZE_SMALL,
    color: rgb(0.5, 0.5, 0.5),
  });
  drawText(ctx, fmtDate(invoice.issueDate), rightCol + 100, yRight);
  yRight -= 14;
  drawText(ctx, 'Fällig am', rightCol, yRight, {
    size: FONT_SIZE_SMALL,
    color: rgb(0.5, 0.5, 0.5),
  });
  drawText(ctx, fmtDate(invoice.dueDate), rightCol + 100, yRight);
  yRight -= 14;
  // iter98: Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG), wenn erfasst.
  if (invoice.servicePeriodStart && invoice.servicePeriodEnd) {
    drawText(ctx, 'Leistungszeitraum', rightCol, yRight, {
      size: FONT_SIZE_SMALL,
      color: rgb(0.5, 0.5, 0.5),
    });
    drawText(
      ctx,
      `${fmtDate(invoice.servicePeriodStart)} – ${fmtDate(invoice.servicePeriodEnd)}`,
      rightCol + 100,
      yRight,
      { size: FONT_SIZE_SMALL },
    );
    yRight -= 14;
  }
  // P2-9: USt-ID ODER (falls nicht vorhanden) Steuernummer — § 14 Abs. 4 Nr. 2
  // UStG verlangt eine der beiden im menschenlesbaren Teil.
  if (seller.vatId) {
    drawText(ctx, 'USt-ID Verkäufer', rightCol, yRight, {
      size: FONT_SIZE_SMALL,
      color: rgb(0.5, 0.5, 0.5),
    });
    drawText(ctx, seller.vatId, rightCol + 100, yRight, { size: FONT_SIZE_SMALL });
  } else if (seller.taxNumber) {
    drawText(ctx, 'Steuernummer', rightCol, yRight, {
      size: FONT_SIZE_SMALL,
      color: rgb(0.5, 0.5, 0.5),
    });
    drawText(ctx, seller.taxNumber, rightCol + 100, yRight, { size: FONT_SIZE_SMALL });
  }

  // Titel
  ctx.y -= 30;
  drawText(ctx, `Rechnung ${invoice.number}`, margin, ctx.y, { bold: true, size: FONT_SIZE_TITLE });
  ctx.y -= 22;
  drawText(ctx, invoice.subject, margin, ctx.y, {
    size: FONT_SIZE_HEADING,
    color: rgb(0.4, 0.4, 0.4),
  });
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
  // iter86: USt-Ausweis je Steuersatz-Gruppe (§ 14 Abs. 4 Nr. 8 UStG).
  for (const g of computeVatTotals(invoice.positions).groups) {
    newPageIfNeeded(ctx, 14);
    drawText(ctx, `USt (${g.rate.toFixed(2)} %)`, sumCol1, ctx.y);
    drawText(ctx, fmtEUR(g.vat), sumCol2, ctx.y);
    ctx.y -= 14;
  }
  drawLine(ctx, ctx.y, rgb(0.4, 0.4, 0.4));
  ctx.y -= 14;
  drawText(ctx, 'Brutto', sumCol1, ctx.y, { bold: true, size: FONT_SIZE_HEADING });
  drawText(ctx, fmtEUR(invoice.totalAmount), sumCol2, ctx.y, {
    bold: true,
    size: FONT_SIZE_HEADING,
  });
  ctx.y -= 30;

  // Notizen
  if (invoice.notes) {
    newPageIfNeeded(ctx, 60);
    drawText(ctx, 'Hinweise', margin, ctx.y, {
      bold: true,
      size: FONT_SIZE_SMALL,
      color: rgb(0.5, 0.5, 0.5),
    });
    ctx.y -= 12;
    // P3-26: Wort-erhaltendes Umbrechen statt hartem slice(0,100) — kein
    // Inhaltsverlust in der revisionssicher archivierten PDF.
    for (const paragraph of invoice.notes.split('\n')) {
      for (const line of wrapText(paragraph, 100)) {
        newPageIfNeeded(ctx, 12);
        drawText(ctx, line, margin, ctx.y);
        ctx.y -= 11;
      }
    }
    ctx.y -= 10;
  }

  // Bankverbindung / Zahlungshinweis
  if (seller.iban) {
    newPageIfNeeded(ctx, 60);
    drawText(ctx, 'Zahlung bitte auf folgendes Konto:', margin, ctx.y, {
      size: FONT_SIZE_SMALL,
      color: rgb(0.5, 0.5, 0.5),
    });
    ctx.y -= 12;
    if (seller.bankName) {
      drawText(ctx, seller.bankName, margin, ctx.y);
      ctx.y -= 11;
    }
    drawText(ctx, `IBAN: ${seller.iban}`, margin, ctx.y);
    ctx.y -= 11;
    if (seller.bic) {
      drawText(ctx, `BIC: ${seller.bic}`, margin, ctx.y);
      ctx.y -= 11;
    }
    drawText(ctx, `Verwendungszweck: ${invoice.number}`, margin, ctx.y);
    ctx.y -= 11;
  }

  // Footer auf JEDER Seite: Kanzlei + ZUGFeRD-Hinweis + Seitenzahl.
  const pages = doc.getPages();
  const pageCount = pages.length;
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: margin, y: letterheadLayout.footerRuleY },
      end: { x: pageWidth - margin, y: letterheadLayout.footerRuleY },
      thickness: 0.4,
      color: rgb(0.75, 0.75, 0.75),
    });
    p.drawText(letterheadLayout.footerSellerLine, {
      x: margin,
      y: letterheadLayout.footerSellerY,
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    p.drawText(`Seite ${i + 1} von ${pageCount}`, {
      x: pageWidth - margin - 60,
      y: letterheadLayout.footerSellerY,
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
    drawLetterheadFooterDetails(p, letterheadLayout, font, margin);
    p.drawText('Diese PDF enthält eine maschinenlesbare ZUGFeRD/Factur-X-XML (Profil EN 16931).', {
      x: margin,
      y: letterheadLayout.footerMachineY,
      size: 7,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  });

  // ----- XML-Anhang einbetten ----------------------------------------------
  await embedFacturXAttachment(doc, ciiXml);

  // ----- XMP-Metadaten (Factur-X-Konformität) ------------------------------
  setFacturXMetadata(doc, invoice.number);

  return doc.save();
}

/**
 * Liest die tatsächlich in einer Factur-X/ZUGFeRD-PDF eingebettete CII-Datei.
 * Der Reparaturpfad für ältere Archive verwendet bewusst diese Bytes statt
 * XML aus heutigen Stammdaten neu zu erzeugen; nur so bleiben Hybrid-PDF und
 * separate XRechnung fachlich identisch.
 */
export async function extractFacturXXml(pdfBytes: Uint8Array): Promise<Buffer> {
  const document = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const names = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const embeddedFiles = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const entries = embeddedFiles?.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (!entries) throw new Error('ZUGFeRD-PDF enthält kein EmbeddedFiles-Verzeichnis.');

  for (let index = 0; index + 1 < entries.size(); index += 2) {
    const fileName = entries.lookupMaybe(index, PDFString, PDFHexString)?.decodeText();
    if (fileName?.toLowerCase() !== 'factur-x.xml') continue;
    const fileSpec = entries.lookupMaybe(index + 1, PDFDict);
    const embedded = fileSpec?.lookupMaybe(PDFName.of('EF'), PDFDict);
    const stream = embedded?.lookupMaybe(PDFName.of('F'), PDFStream);
    if (!(stream instanceof PDFRawStream)) {
      throw new Error('Factur-X-Anhang besitzt keinen lesbaren PDF-Stream.');
    }
    return Buffer.from(decodePDFRawStream(stream).decode());
  }
  throw new Error('ZUGFeRD-PDF enthält keinen factur-x.xml-Anhang.');
}

/**
 * Bettet die CII-XML als Datei-Anhang in das PDF ein, mit dem Filename
 * `factur-x.xml` und der Beziehung "Alternative" (AFRelationship).
 */
async function embedFacturXAttachment(doc: PDFDocument, ciiXml: string): Promise<void> {
  const xmlBytes = new TextEncoder().encode(ciiXml);

  // pdf-lib high-level attach()-API. P2-8: AFRelationship MUSS "Alternative"
  // sein (ZUGFeRD 2.x / Factur-X: die XML ist eine ALTERNATIVE Repräsentation
  // der Rechnung, kein „Source"). „Source" ließ konforme Verarbeiter die
  // Rechnung nicht als hybrid erkennen.
  await doc.attach(xmlBytes, 'factur-x.xml', {
    mimeType: 'application/xml',
    description: 'Factur-X invoice XML (CII)',
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Alternative,
  });
}

/** XML-escapen für den XMP-Klartext (Rechnungsnummer). */
function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Baut den Factur-X-XMP-Metadatenblock (RDF/XML). Enthält die fx-
 * Erweiterungsschema-Deklaration + die vier Factur-X-Kernfelder, an denen
 * konforme Rechnungsverarbeiter (DATEV etc.) das Hybrid-Dokument erkennen.
 *
 * BEWUSST OHNE pdfaid:part=3-Behauptung: Diese PDF ist KEIN strikt validiertes
 * PDF/A-3 (nicht eingebettete Standard-Fonts, kein OutputIntent/ICC). Ein
 * falsches pdfaid würde einen strengen Validator scheitern lassen. Die
 * Factur-X-Erkennung (Attachment „Alternative" + fx-XMP) funktioniert dennoch.
 */
function buildFacturXXmp(invoiceNumber: string): string {
  const title = xmlEsc(`Rechnung ${invoiceNumber}`);
  const FX_NS = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
  // XMP-Byte-Order-Mark programmatisch (kein literales Sonderzeichen im
  // Quelltext → kein ESLint no-irregular-whitespace).
  const BOM = String.fromCharCode(0xfeff);
  return `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>taxtronik</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>taxtronik</xmp:CreatorTool>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="${FX_NS}">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>${FX_NS}</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the Factur-X data</pdfaProperty:description></rdf:li>
                <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the Factur-X data</pdfaProperty:description></rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Setzt Document-Info + den Factur-X-XMP-Metadatenstrom am Katalog. Erkennung
 * durch Factur-X-Verarbeiter, ohne strikte PDF/A-3-Konformität zu behaupten
 * (s. buildFacturXXmp — eingebettete Fonts/OutputIntent fehlen bewusst).
 */
function setFacturXMetadata(doc: PDFDocument, invoiceNumber: string): void {
  doc.setTitle(`Rechnung ${invoiceNumber}`);
  doc.setSubject('ZUGFeRD/Factur-X invoice — EN 16931');
  doc.setKeywords(['ZUGFeRD', 'Factur-X', 'EN 16931', 'XRechnung', 'Rechnung']);
  doc.setProducer('taxtronik');
  doc.setCreator('taxtronik');

  // XMP-Metadatenstrom am Document-Catalog verankern (/Metadata).
  const xmp = buildFacturXXmp(invoiceNumber);
  const metadataStream = doc.context.stream(xmp, {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  const ref = doc.context.register(metadataStream);
  doc.catalog.set(PDFName.of('Metadata'), ref);

  // PDF-Info-Dictionary um Factur-X-Schlüssel ergänzen — manche Verarbeiter
  // lesen Document-Info statt XMP. `getInfoDict` ist in pdf-lib privat — Cast.
  const docAny = doc as unknown as { getInfoDict(): PDFRef };
  const info = doc.context.lookup(docAny.getInfoDict()) as PDFDict | undefined;
  if (info) {
    info.set(PDFName.of('FacturXVersion'), PDFString.of('1.0'));
    info.set(PDFName.of('FacturXConformanceLevel'), PDFString.of('EN 16931'));
    info.set(PDFName.of('FacturXDocumentType'), PDFString.of('INVOICE'));
    info.set(PDFName.of('FacturXFilename'), PDFString.of('factur-x.xml'));
  }
}
