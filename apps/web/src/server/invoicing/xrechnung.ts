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

export interface XRechnungInvoice {
  number: string;
  issueDate: Date;
  dueDate: Date;
  subject: string;
  notes: string | null;
  currency: 'EUR';
  vatRate: number; // z. B. 19
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  positions: Array<{
    position: number;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    netAmount: number;
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

function dateTime(parent: XMLBuilder, ns: string, date: Date): void {
  parent.ele(ns, 'udt:DateTimeString', { format: '102' }).txt(fmtDate(date));
}

export function generateXRechnungCii(
  invoice: XRechnungInvoice,
  seller: SellerInfo,
  buyer: XRechnungBuyer,
): string {
  const RSM = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';
  const RAM = 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100';
  const UDT = 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100';

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(RSM, 'rsm:CrossIndustryInvoice', {
    'xmlns:ram': RAM,
    'xmlns:udt': UDT,
  });

  // -------------------------------------------------------------------------
  // ExchangedDocumentContext
  // -------------------------------------------------------------------------
  root
    .ele(RSM, 'rsm:ExchangedDocumentContext')
    .ele(RAM, 'ram:GuidelineSpecifiedDocumentContextParameter')
    .ele(RAM, 'ram:ID')
    .txt('urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0');

  // -------------------------------------------------------------------------
  // ExchangedDocument
  // -------------------------------------------------------------------------
  const exDoc = root.ele(RSM, 'rsm:ExchangedDocument');
  exDoc.ele(RAM, 'ram:ID').txt(invoice.number);
  exDoc.ele(RAM, 'ram:TypeCode').txt('380');
  dateTime(exDoc.ele(RAM, 'ram:IssueDateTime'), RAM, invoice.issueDate);

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
    lineTax.ele(RAM, 'ram:CategoryCode').txt('S');
    lineTax.ele(RAM, 'ram:RateApplicablePercent').txt(invoice.vatRate.toFixed(2));
    lineSettle
      .ele(RAM, 'ram:SpecifiedTradeSettlementLineMonetarySummation')
      .ele(RAM, 'ram:LineTotalAmount')
      .txt(fmtAmount(pos.netAmount));
  }

  // -------------------------------------------------------------------------
  // Header — Agreement (Seller + Buyer)
  // -------------------------------------------------------------------------
  const agreement = sct.ele(RAM, 'ram:ApplicableHeaderTradeAgreement');

  // Seller
  const sellerEl = agreement.ele(RAM, 'ram:SellerTradeParty');
  sellerEl.ele(RAM, 'ram:Name').txt(seller.name);

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
  // Header — Delivery (leer, da Dienstleistungsrechnung)
  // -------------------------------------------------------------------------
  sct.ele(RAM, 'ram:ApplicableHeaderTradeDelivery');

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

  // Steuerblock
  const tax = settle.ele(RAM, 'ram:ApplicableTradeTax');
  tax.ele(RAM, 'ram:CalculatedAmount').txt(fmtAmount(invoice.vatAmount));
  tax.ele(RAM, 'ram:TypeCode').txt('VAT');
  tax.ele(RAM, 'ram:BasisAmount').txt(fmtAmount(invoice.netAmount));
  tax.ele(RAM, 'ram:CategoryCode').txt('S');
  tax.ele(RAM, 'ram:RateApplicablePercent').txt(invoice.vatRate.toFixed(2));

  // Zahlungsbedingungen
  const terms = settle.ele(RAM, 'ram:SpecifiedTradePaymentTerms');
  terms
    .ele(RAM, 'ram:Description')
    .txt(`Zahlbar bis ${new Intl.DateTimeFormat('de-DE').format(invoice.dueDate)}`);
  dateTime(terms.ele(RAM, 'ram:DueDateDateTime'), RAM, invoice.dueDate);

  // Summen
  const sum = settle.ele(RAM, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation');
  sum.ele(RAM, 'ram:LineTotalAmount').txt(fmtAmount(invoice.netAmount));
  sum.ele(RAM, 'ram:TaxBasisTotalAmount').txt(fmtAmount(invoice.netAmount));
  sum
    .ele(RAM, 'ram:TaxTotalAmount', { currencyID: invoice.currency })
    .txt(fmtAmount(invoice.vatAmount));
  sum.ele(RAM, 'ram:GrandTotalAmount').txt(fmtAmount(invoice.totalAmount));
  sum.ele(RAM, 'ram:DuePayableAmount').txt(fmtAmount(invoice.totalAmount));

  return doc.end({ prettyPrint: true });
}
