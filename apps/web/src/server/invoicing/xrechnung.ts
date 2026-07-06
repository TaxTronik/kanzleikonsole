// =============================================================================
// XRechnung 3.0 CII-XML-Generator
//
// Erzeugt eine XRechnung-konforme UN/CEFACT-CII-XML-Datei für eine Rechnung.
// Profil: urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0
//
// Diese Datei kann direkt an öffentliche Auftraggeber (B2G) und ab 2025
// auch B2B übermittelt werden.
//
// Hinweise:
// - Beträge werden mit 2 Nachkommastellen ausgegeben (Währung EUR).
// - Dokumenttyp 380 = Handelsrechnung. Stornorechnung wäre 381.
// - VAT category code "S" = Standard rate. Andere: "Z" (zero), "E" (exempt), "K" (intra-EU).
// - Für eine vollständige XRechnung sind in der Praxis weitere Felder nötig
//   (z. B. Buyer Reference / Leitweg-ID für B2G). Diese werden, falls leer,
//   weggelassen — gilt als "best effort" für B2B.
//
// Implementierung: nutzt xmlbuilder2 — robusterer Builder mit korrektem
// Escaping (inkl. Attribute), garantierter Element-Reihenfolge und sauberer
// Namespace-Behandlung. Vorher String-Konkatenation, was bei UBL-Erweiterungen
// fragil war.
// =============================================================================

import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces';
import type { SellerInfo } from '@/server/settings/tenant-settings';
import { computeVatTotals, vatCategory } from '@/server/invoicing/vat';
import { fmtDateShort } from '@/lib/fmt';

export interface XRechnungInvoice {
  number: string;
  issueDate: Date;
  dueDate: Date;
  subject: string;
  notes: string | null;
  currency: 'EUR';
  // iter98: Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG). Beide gesetzt → BG-14
  // (BT-73/BT-74). NULL → Konvention „Leistungsdatum = Rechnungsdatum" (BT-72).
  servicePeriodStart?: Date | null;
  servicePeriodEnd?: Date | null;
  // iter100: Dokumenttyp (380 Rechnung, 381 Storno/Korrekturbeleg) + Referenz
  // auf die stornierte Rechnung (BG-3/BT-25).
  typeCode?: '380' | '381';
  precedingInvoiceNumber?: string | null;
  // iter101: Befreiungsgrund für 0 %-Umsätze (BT-120, Kategorie „E").
  vatExemptionReason?: string | null;
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  // iter86: Steuersatz je Position (§ 14 Abs. 4 Nr. 8 UStG); der Header-
  // Steuerblock wird daraus je Satz gruppiert gebildet.
  positions: Array<{
    position: number;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    netAmount: number;
    vatRate: number;
  }>;
}

export interface XRechnungBuyer {
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string;
  vatId: string | null;
  email: string | null;
  /** Käuferreferenz (BT-10, BR-DE-15 Pflicht). B2G: Leitweg-ID; B2B üblich:
   *  vereinbarte Referenz/E-Mail. Fallback in der Generierung: email → name. */
  reference?: string | null;
}

function fmtDate(d: Date): string {
  // CII format 102 = YYYYMMDD
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function fmtAmount(n: number | { toString(): string }): string {
  return Number(n.toString()).toFixed(2);
}

/**
 * Mapping interner Einheiten auf UN/ECE Recommendation 20 codes.
 * Siehe: https://unece.org/trade/uncefact/cl-recommendations
 */
function unitCode(unit: string): string {
  const u = unit.toLowerCase().trim();
  if (u === 'stunde' || u === 'stunden' || u === 'h' || u === 'std') return 'HUR';
  if (u === 'tag' || u === 'tage' || u === 'd') return 'DAY';
  if (u === 'monat' || u === 'monate') return 'MON';
  if (u === 'kg') return 'KGM';
  if (u === 'liter' || u === 'l') return 'LTR';
  if (u === 'meter' || u === 'm') return 'MTR';
  if (u === 'pauschal' || u === 'pauschale') return 'LS'; // Lump sum
  // Default: Stück
  return 'C62';
}

const RSM = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';
const RAM = 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100';
const UDT = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100';

// KoSIT-Befund 2026-06: DateTimeString MUSS im UDT-Namespace liegen — vorher
// wurde der RAM-Namespace des Eltern-Elements durchgereicht (Prefix `udt:` mit
// falscher Namespace-URI), was die CII-Schema-Validierung ablehnt.
function dateTime(parent: XMLBuilder, date: Date): void {
  parent.ele(UDT, 'udt:DateTimeString', { format: '102' }).txt(fmtDate(date));
}

export function generateXRechnungCii(
  invoice: XRechnungInvoice,
  seller: SellerInfo,
  buyer: XRechnungBuyer,
): string {

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(RSM, 'rsm:CrossIndustryInvoice', {
    'xmlns:ram': RAM,
    'xmlns:udt': UDT,
  });

  // -------------------------------------------------------------------------
  // ExchangedDocumentContext
  // -------------------------------------------------------------------------
  const docContext = root.ele(RSM, 'rsm:ExchangedDocumentContext');
  // BT-23 Geschäftsprozess: Pflicht (PEPPOL-EN16931-R001), Standard-Prozesskennung.
  docContext
    .ele(RAM, 'ram:BusinessProcessSpecifiedDocumentContextParameter')
    .ele(RAM, 'ram:ID')
    .txt('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0');
  docContext
    .ele(RAM, 'ram:GuidelineSpecifiedDocumentContextParameter')
    .ele(RAM, 'ram:ID')
    .txt('urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0');

  // -------------------------------------------------------------------------
  // ExchangedDocument
  // -------------------------------------------------------------------------
  const exDoc = root.ele(RSM, 'rsm:ExchangedDocument');
  exDoc.ele(RAM, 'ram:ID').txt(invoice.number);
  exDoc.ele(RAM, 'ram:TypeCode').txt(invoice.typeCode ?? '380');
  dateTime(exDoc.ele(RAM, 'ram:IssueDateTime'), invoice.issueDate);

  if (invoice.notes) {
    exDoc.ele(RAM, 'ram:IncludedNote').ele(RAM, 'ram:Content').txt(invoice.notes);
  }
  if (invoice.subject) {
    const note = exDoc.ele(RAM, 'ram:IncludedNote');
    note.ele(RAM, 'ram:Content').txt(invoice.subject);
    note.ele(RAM, 'ram:SubjectCode').txt('AAI');
  }

  // -------------------------------------------------------------------------
  // SupplyChainTradeTransaction
  // -------------------------------------------------------------------------
  const sct = root.ele(RSM, 'rsm:SupplyChainTradeTransaction');

  // Lines
  for (const pos of invoice.positions) {
    const line = sct.ele(RAM, 'ram:IncludedSupplyChainTradeLineItem');

    line
      .ele(RAM, 'ram:AssociatedDocumentLineDocument')
      .ele(RAM, 'ram:LineID')
      .txt(String(pos.position));

    line
      .ele(RAM, 'ram:SpecifiedTradeProduct')
      .ele(RAM, 'ram:Name')
      .txt(pos.description);

    line
      .ele(RAM, 'ram:SpecifiedLineTradeAgreement')
      .ele(RAM, 'ram:NetPriceProductTradePrice')
      .ele(RAM, 'ram:ChargeAmount')
      .txt(fmtAmount(pos.unitPrice));

    line
      .ele(RAM, 'ram:SpecifiedLineTradeDelivery')
      .ele(RAM, 'ram:BilledQuantity', { unitCode: unitCode(pos.unit) })
      .txt(fmtAmount(pos.quantity));

    const lineSettle = line.ele(RAM, 'ram:SpecifiedLineTradeSettlement');
    const lineTax = lineSettle.ele(RAM, 'ram:ApplicableTradeTax');
    lineTax.ele(RAM, 'ram:TypeCode').txt('VAT');
    lineTax.ele(RAM, 'ram:CategoryCode').txt(vatCategory(pos.vatRate, !!invoice.vatExemptionReason));
    lineTax.ele(RAM, 'ram:RateApplicablePercent').txt(pos.vatRate.toFixed(2));
    lineSettle
      .ele(RAM, 'ram:SpecifiedTradeSettlementLineMonetarySummation')
      .ele(RAM, 'ram:LineTotalAmount')
      .txt(fmtAmount(pos.netAmount));
  }

  // -------------------------------------------------------------------------
  // Header — Agreement (Seller + Buyer)
  // -------------------------------------------------------------------------
  const agreement = sct.ele(RAM, 'ram:ApplicableHeaderTradeAgreement');

  // BT-10 Käuferreferenz (BR-DE-15 Pflicht, KoSIT 2026-06). MUSS als erstes
  // Kind des Agreements stehen (CII-Elementreihenfolge).
  agreement
    .ele(RAM, 'ram:BuyerReference')
    .txt(buyer.reference || buyer.email || buyer.name);

  // Seller
  const sellerEl = agreement.ele(RAM, 'ram:SellerTradeParty');
  sellerEl.ele(RAM, 'ram:Name').txt(seller.name);

  // BG-6 Verkäufer-Kontakt (BR-DE-2 Pflicht, KoSIT 2026-06). CII-Reihenfolge:
  // DefinedTradeContact VOR PostalTradeAddress.
  const contact = sellerEl.ele(RAM, 'ram:DefinedTradeContact');
  contact.ele(RAM, 'ram:PersonName').txt(seller.name);
  if (seller.phone) {
    contact
      .ele(RAM, 'ram:TelephoneUniversalCommunication')
      .ele(RAM, 'ram:CompleteNumber')
      .txt(seller.phone);
  }
  if (seller.email) {
    contact
      .ele(RAM, 'ram:EmailURIUniversalCommunication')
      .ele(RAM, 'ram:URIID')
      .txt(seller.email);
  }

  const sellerAddr = sellerEl.ele(RAM, 'ram:PostalTradeAddress');
  if (seller.postalCode) sellerAddr.ele(RAM, 'ram:PostcodeCode').txt(seller.postalCode);
  if (seller.street) sellerAddr.ele(RAM, 'ram:LineOne').txt(seller.street);
  if (seller.city) sellerAddr.ele(RAM, 'ram:CityName').txt(seller.city);
  sellerAddr.ele(RAM, 'ram:CountryID').txt(seller.countryIso);

  if (seller.email) {
    sellerEl
      .ele(RAM, 'ram:URIUniversalCommunication')
      .ele(RAM, 'ram:URIID', { schemeID: 'EM' })
      .txt(seller.email);
  }
  if (seller.vatId) {
    sellerEl
      .ele(RAM, 'ram:SpecifiedTaxRegistration')
      .ele(RAM, 'ram:ID', { schemeID: 'VA' })
      .txt(seller.vatId);
  }
  if (seller.taxNumber) {
    sellerEl
      .ele(RAM, 'ram:SpecifiedTaxRegistration')
      .ele(RAM, 'ram:ID', { schemeID: 'FC' })
      .txt(seller.taxNumber);
  }

  // Buyer
  const buyerEl = agreement.ele(RAM, 'ram:BuyerTradeParty');
  buyerEl.ele(RAM, 'ram:Name').txt(buyer.name);

  const buyerAddr = buyerEl.ele(RAM, 'ram:PostalTradeAddress');
  if (buyer.postalCode) buyerAddr.ele(RAM, 'ram:PostcodeCode').txt(buyer.postalCode);
  if (buyer.street) buyerAddr.ele(RAM, 'ram:LineOne').txt(buyer.street);
  if (buyer.city) buyerAddr.ele(RAM, 'ram:CityName').txt(buyer.city);
  buyerAddr.ele(RAM, 'ram:CountryID').txt(buyer.countryIso);

  if (buyer.email) {
    buyerEl
      .ele(RAM, 'ram:URIUniversalCommunication')
      .ele(RAM, 'ram:URIID', { schemeID: 'EM' })
      .txt(buyer.email);
  }
  if (buyer.vatId) {
    buyerEl
      .ele(RAM, 'ram:SpecifiedTaxRegistration')
      .ele(RAM, 'ram:ID', { schemeID: 'VA' })
      .txt(buyer.vatId);
  }

  // -------------------------------------------------------------------------
  // Header — Delivery. BT-72 Leistungsdatum: ist ein Leistungszeitraum erfasst,
  // gilt dessen ENDE als Leistungsdatum (§ 14 Abs. 4 Nr. 6 UStG), sonst die
  // Konvention „Leistungsdatum = Rechnungsdatum". Der Zeitraum selbst wird
  // zusätzlich als BG-14 im Settlement ausgewiesen.
  // -------------------------------------------------------------------------
  dateTime(
    sct
      .ele(RAM, 'ram:ApplicableHeaderTradeDelivery')
      .ele(RAM, 'ram:ActualDeliverySupplyChainEvent')
      .ele(RAM, 'ram:OccurrenceDateTime'),
    invoice.servicePeriodEnd ?? invoice.issueDate,
  );

  // -------------------------------------------------------------------------
  // Header — Settlement
  // -------------------------------------------------------------------------
  const settle = sct.ele(RAM, 'ram:ApplicableHeaderTradeSettlement');
  settle.ele(RAM, 'ram:InvoiceCurrencyCode').txt(invoice.currency);

  if (seller.iban) {
    const pay = settle.ele(RAM, 'ram:SpecifiedTradeSettlementPaymentMeans');
    pay.ele(RAM, 'ram:TypeCode').txt('58');
    const acct = pay.ele(RAM, 'ram:PayeePartyCreditorFinancialAccount');
    acct.ele(RAM, 'ram:IBANID').txt(seller.iban);
    if (seller.bankName) acct.ele(RAM, 'ram:AccountName').txt(seller.bankName);
    if (seller.bic) {
      pay
        .ele(RAM, 'ram:PayeeSpecifiedCreditorFinancialInstitution')
        .ele(RAM, 'ram:BICID')
        .txt(seller.bic);
    }
  }

  // Steuerblock: EIN ApplicableTradeTax je Steuersatz-Gruppe (EN 16931 BG-23;
  // § 14 Abs. 4 Nr. 8 UStG — Entgelt aufgeschlüsselt nach Sätzen).
  for (const g of computeVatTotals(invoice.positions).groups) {
    const category = vatCategory(g.rate, !!invoice.vatExemptionReason);
    const tax = settle.ele(RAM, 'ram:ApplicableTradeTax');
    tax.ele(RAM, 'ram:CalculatedAmount').txt(fmtAmount(g.vat));
    tax.ele(RAM, 'ram:TypeCode').txt('VAT');
    // BT-120 Befreiungsgrund (Pflicht bei Kategorie „E", § 14 Abs. 4 Nr. 8 UStG).
    if (category === 'E' && invoice.vatExemptionReason) {
      tax.ele(RAM, 'ram:ExemptionReason').txt(invoice.vatExemptionReason);
    }
    tax.ele(RAM, 'ram:BasisAmount').txt(fmtAmount(g.net));
    tax.ele(RAM, 'ram:CategoryCode').txt(category);
    tax.ele(RAM, 'ram:RateApplicablePercent').txt(g.rate.toFixed(2));
  }

  // BG-14 Rechnungs-/Leistungszeitraum (BT-73/BT-74) — nur wenn erfasst.
  // Reihenfolge im CII-Settlement: nach ApplicableTradeTax, vor PaymentTerms.
  if (invoice.servicePeriodStart && invoice.servicePeriodEnd) {
    const period = settle.ele(RAM, 'ram:BillingSpecifiedPeriod');
    dateTime(period.ele(RAM, 'ram:StartDateTime'), invoice.servicePeriodStart);
    dateTime(period.ele(RAM, 'ram:EndDateTime'), invoice.servicePeriodEnd);
  }

  // Zahlungsbedingungen
  const terms = settle.ele(RAM, 'ram:SpecifiedTradePaymentTerms');
  terms
    .ele(RAM, 'ram:Description')
    .txt(`Zahlbar bis ${fmtDateShort(invoice.dueDate)}`);
  dateTime(terms.ele(RAM, 'ram:DueDateDateTime'), invoice.dueDate);

  // Summen
  const sum = settle.ele(RAM, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation');
  sum.ele(RAM, 'ram:LineTotalAmount').txt(fmtAmount(invoice.netAmount));
  sum.ele(RAM, 'ram:TaxBasisTotalAmount').txt(fmtAmount(invoice.netAmount));
  sum
    .ele(RAM, 'ram:TaxTotalAmount', { currencyID: invoice.currency })
    .txt(fmtAmount(invoice.vatAmount));
  sum.ele(RAM, 'ram:GrandTotalAmount').txt(fmtAmount(invoice.totalAmount));
  sum.ele(RAM, 'ram:DuePayableAmount').txt(fmtAmount(invoice.totalAmount));

  // BG-3 Referenz auf die vorausgegangene (stornierte) Rechnung — bei Storno.
  if (invoice.precedingInvoiceNumber) {
    settle
      .ele(RAM, 'ram:InvoiceReferencedDocument')
      .ele(RAM, 'ram:IssuerAssignedID')
      .txt(invoice.precedingInvoiceNumber);
  }

  return doc.end({ prettyPrint: true });
}
