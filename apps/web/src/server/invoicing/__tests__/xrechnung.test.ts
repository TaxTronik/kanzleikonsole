import { describe, it, expect } from 'vitest';
import { generateXRechnungCii, toXRechnungInvoice } from '../xrechnung';
import { toStornoPosition } from '../storno';
// Geteilte Fixture (Mischsätze 19/7/0 %) — auch Input der KoSIT-Validierung
// im CI-Job `e-rechnung` (cli/generate-sample.ts).
import {
  SAMPLE_INVOICE,
  SAMPLE_SELLER,
  SAMPLE_BUYER,
  SAMPLE_STORNO_INVOICE,
} from '../sample-fixture';

describe('generateXRechnungCii — USt je Position (iter86)', () => {
  const xml = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);

  it('Header-Steuerblock: EIN ApplicableTradeTax je Satz-Gruppe', () => {
    // 3 Zeilen-Steuern + 3 Header-Gruppen = 6 ApplicableTradeTax gesamt
    const all = xml.match(/<ram:ApplicableTradeTax>/g) ?? [];
    expect(all).toHaveLength(6);
    // Header-Gruppen tragen CalculatedAmount (Zeilen nicht)
    expect(xml.match(/<ram:CalculatedAmount>/g) ?? []).toHaveLength(3);
    expect(xml).toContain('<ram:CalculatedAmount>19.00</ram:CalculatedAmount>');
    expect(xml).toContain('<ram:CalculatedAmount>7.00</ram:CalculatedAmount>');
    expect(xml).toContain('<ram:CalculatedAmount>0.00</ram:CalculatedAmount>');
    expect(xml).toContain('<ram:BasisAmount>50.00</ram:BasisAmount>');
  });

  it('Positions-Sätze: 19/7 → Kategorie S, 0 → Kategorie Z', () => {
    expect(xml).toContain('<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>');
    expect(xml).toContain('<ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>');
    expect(xml).toContain('<ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>');
    expect(xml.match(/<ram:CategoryCode>Z<\/ram:CategoryCode>/g) ?? []).toHaveLength(2); // Zeile + Gruppe
    expect(xml.match(/<ram:CategoryCode>S<\/ram:CategoryCode>/g) ?? []).toHaveLength(4); // 2 Zeilen + 2 Gruppen
  });

  it('Summen konsistent (Netto/USt/Brutto)', () => {
    expect(xml).toContain('<ram:TaxBasisTotalAmount>250.00</ram:TaxBasisTotalAmount>');
    expect(xml).toContain('currencyID="EUR">26.00</ram:TaxTotalAmount>');
    expect(xml).toContain('<ram:GrandTotalAmount>276.00</ram:GrandTotalAmount>');
    expect(xml).toContain('<ram:DuePayableAmount>276.00</ram:DuePayableAmount>');
  });

  it('XRechnung-3.0-Profil + Rechnungsnummer', () => {
    expect(xml).toContain('urn:xeinkauf.de:kosit:xrechnung_3.0');
    expect(xml).toContain('<ram:ID>2026-0042</ram:ID>');
  });

  it('KoSIT-Pflichtelemente: BT-23, BT-10, BG-6, BT-72', () => {
    // BT-23 Geschäftsprozess (PEPPOL-EN16931-R001)
    expect(xml).toContain('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0');
    // BT-10 Käuferreferenz (BR-DE-15) — Fallback: Buyer-E-Mail
    expect(xml).toContain('<ram:BuyerReference>buchhaltung@mandant.example</ram:BuyerReference>');
    // BG-6 Verkäufer-Kontakt (BR-DE-2) mit Telefon (BT-42) und E-Mail (BT-43)
    expect(xml).toContain('<ram:DefinedTradeContact>');
    expect(xml).toContain('<ram:CompleteNumber>+49 30 1234567</ram:CompleteNumber>');
    expect(xml).toContain('<ram:URIID>rechnung@musterkanzlei.example</ram:URIID>');
    // BT-72 Liefer-/Leistungsdatum (BR-DE-TMP-32) — ohne Zeitraum = Rechnungsdatum
    expect(xml).toContain('<ram:ActualDeliverySupplyChainEvent>');
    expect(xml).toContain('20260610');
  });

  it('ohne Leistungszeitraum: kein BG-14 (BillingSpecifiedPeriod)', () => {
    expect(xml).not.toContain('<ram:BillingSpecifiedPeriod>');
  });
});

describe('generateXRechnungCii — 0 %-Befreiungsgrund (iter101, Kategorie E/BT-120)', () => {
  it('0 %-Gruppe wird mit Grund zu Kategorie E + ExemptionReason', () => {
    const xml = generateXRechnungCii(
      { ...SAMPLE_INVOICE, vatExemptionReason: '§ 19 UStG Kleinunternehmer' },
      SAMPLE_SELLER,
      SAMPLE_BUYER,
    );
    expect(xml).toContain('<ram:ExemptionReason>§ 19 UStG Kleinunternehmer</ram:ExemptionReason>');
    // 0 %-Positionen jetzt Kategorie E (statt Z); 19/7 bleiben S.
    expect(xml).toMatch(/<ram:CategoryCode>E<\/ram:CategoryCode>/);
  });

  it('ohne Grund bleibt die 0 %-Gruppe Kategorie Z (kein ExemptionReason)', () => {
    const xml = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
    expect(xml).not.toContain('<ram:ExemptionReason>');
    expect(xml).toMatch(/<ram:CategoryCode>Z<\/ram:CategoryCode>/);
  });
});

describe('generateXRechnungCii — Reverse-Charge (iter107, Kategorie AE/§ 13b)', () => {
  const rc = generateXRechnungCii(
    {
      ...SAMPLE_INVOICE,
      reverseCharge: true,
      // Reverse-Charge weist alle Positionen mit 0 % aus.
      positions: SAMPLE_INVOICE.positions.map((p) => ({ ...p, vatRate: 0 })),
    },
    SAMPLE_SELLER,
    SAMPLE_BUYER,
  );

  it('Kategorie AE mit Reverse-Charge-Grund (BT-120), keine S/Z-Kategorie', () => {
    expect(rc).toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
    expect(rc).toContain(
      '<ram:ExemptionReason>Steuerschuldnerschaft des Leistungsempfängers</ram:ExemptionReason>',
    );
    expect(rc).not.toContain('<ram:CategoryCode>S</ram:CategoryCode>');
    expect(rc).not.toContain('<ram:CategoryCode>Z</ram:CategoryCode>');
  });
});

// Fachkatalog: INV-STORNO-REFERENCE-001
// Unabhängige Vorgabe: XRechnung 3.0.2 Kap. 13.1 / E-Rechnung-Bund FAQ:
// negative Rechnungskorrektur = BT-3 384, Referenz BG-3, positive Preise.
describe('generateXRechnungCii — Storno (TypeCode 384)', () => {
  const storno = generateXRechnungCii(
    { ...SAMPLE_STORNO_INVOICE, precedingInvoiceNumber: '2026-0041' },
    SAMPLE_SELLER,
    SAMPLE_BUYER,
  );

  it('kennzeichnet negative Beträge als Korrekturrechnung ohne doppelte Vorzeichenumkehr', () => {
    expect(storno).toContain('<ram:TypeCode>384</ram:TypeCode>');
    expect(storno).not.toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(storno).not.toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(storno).toContain('<ram:GrandTotalAmount>-119.00</ram:GrandTotalAmount>');
  });

  it('referenziert die stornierte Rechnung (BG-3/BT-25)', () => {
    expect(storno).toContain('<ram:InvoiceReferencedDocument>');
    expect(storno).toContain('<ram:IssuerAssignedID>2026-0041</ram:IssuerAssignedID>');
  });

  it('ohne Storno bleibt TypeCode 380 und keine Referenz', () => {
    const normal = generateXRechnungCii(SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER);
    expect(normal).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(normal).not.toContain('<ram:InvoiceReferencedDocument>');
  });

  it('modelliert negative Zeilen über die Menge, nie über einen negativen BT-146-Preis (BR-27)', () => {
    const correction = generateXRechnungCii(
      {
        ...SAMPLE_INVOICE,
        typeCode: '384',
        precedingInvoiceNumber: '2026-0041',
        netAmount: -100,
        vatAmount: -19,
        totalAmount: -119,
        positions: [
          {
            ...SAMPLE_INVOICE.positions[0]!,
            quantity: -1,
            unitPrice: 100,
            netAmount: -100,
          },
        ],
      },
      SAMPLE_SELLER,
      SAMPLE_BUYER,
    );
    expect(correction).toContain('<ram:ChargeAmount>100.00</ram:ChargeAmount>');
    expect(correction).toContain('<ram:BilledQuantity unitCode="HUR">-1.00</ram:BilledQuantity>');
    expect(correction).not.toMatch(/<ram:ChargeAmount>-/);
  });
});

describe('toXRechnungInvoice — einheitliche Route-/Archiv-Abbildung', () => {
  it('erhält Reverse-Charge, Leistungszeitraum und Storno-Referenz gemeinsam', () => {
    const start = new Date(Date.UTC(2026, 4, 1));
    const end = new Date(Date.UTC(2026, 4, 31));
    const mapped = toXRechnungInvoice({
      number: '2026-0042',
      issueDate: SAMPLE_INVOICE.issueDate,
      dueDate: SAMPLE_INVOICE.dueDate,
      subject: 'RC-Korrektur',
      notes: null,
      servicePeriodStart: start,
      servicePeriodEnd: end,
      vatExemptionReason: null,
      reverseCharge: true,
      stornoOfId: '00000000-0000-0000-0000-000000000001',
      stornoOf: { number: '2026-0041' },
      netAmount: -100,
      vatAmount: 0,
      totalAmount: -100,
      positions: [
        {
          position: 1,
          description: 'Beratung',
          quantity: -1,
          unit: 'Stunde',
          unitPrice: 100,
          netAmount: -100,
          vatRate: 0,
        },
      ],
    });

    expect(mapped).toMatchObject({
      reverseCharge: true,
      typeCode: '384',
      precedingInvoiceNumber: '2026-0041',
      servicePeriodStart: start,
      servicePeriodEnd: end,
    });
    const xml = generateXRechnungCii(mapped, SAMPLE_SELLER, {
      ...SAMPLE_BUYER,
      vatId: 'DE123456789',
    });
    expect(xml).toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
    expect(xml).toContain('<ram:TypeCode>384</ram:TypeCode>');
    expect(xml).toContain('<ram:IssuerAssignedID>2026-0041</ram:IssuerAssignedID>');
  });

  it('führt Originalpositionen über den Storno-Mapper bis zum CII-Korrekturbeleg', () => {
    const original = {
      position: 1,
      description: 'Beratung',
      quantity: 1,
      unit: 'Stunde',
      unitPrice: 100,
      netAmount: 100,
      vatRate: 19,
    };
    const correction = toXRechnungInvoice({
      ...SAMPLE_INVOICE,
      servicePeriodStart: null,
      servicePeriodEnd: null,
      vatExemptionReason: null,
      reverseCharge: false,
      stornoOfId: 'original',
      stornoOf: { number: '2026-0041' },
      netAmount: -100,
      vatAmount: -19,
      totalAmount: -119,
      positions: [toStornoPosition(original)],
    });
    const xml = generateXRechnungCii(correction, SAMPLE_SELLER, SAMPLE_BUYER);
    expect(xml).toContain('<ram:TypeCode>384</ram:TypeCode>');
    expect(xml).not.toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xml).toContain('<ram:BilledQuantity unitCode="HUR">-1.00</ram:BilledQuantity>');
    expect(xml).toContain('<ram:ChargeAmount>100.00</ram:ChargeAmount>');
    expect(xml).toContain('<ram:LineTotalAmount>-100.00</ram:LineTotalAmount>');
    expect(xml).toContain('<ram:CalculatedAmount>-19.00</ram:CalculatedAmount>');
    expect(xml).toContain('<ram:DuePayableAmount>-119.00</ram:DuePayableAmount>');
  });
});

describe('generateXRechnungCii — Leistungszeitraum (iter98, BG-14)', () => {
  const withPeriod = generateXRechnungCii(
    {
      ...SAMPLE_INVOICE,
      servicePeriodStart: new Date(Date.UTC(2026, 4, 1)),
      servicePeriodEnd: new Date(Date.UTC(2026, 4, 31)),
    },
    SAMPLE_SELLER,
    SAMPLE_BUYER,
  );

  it('erzeugt BG-14 mit BT-73/BT-74 (Start/Ende)', () => {
    expect(withPeriod).toContain('<ram:BillingSpecifiedPeriod>');
    expect(withPeriod).toContain('<ram:StartDateTime>');
    expect(withPeriod).toContain('20260501');
    expect(withPeriod).toContain('<ram:EndDateTime>');
    expect(withPeriod).toContain('20260531');
  });

  it('BT-72 Leistungsdatum wird das Zeitraum-Ende (nicht das Rechnungsdatum)', () => {
    const delivery = withPeriod.match(
      /<ram:ActualDeliverySupplyChainEvent>[\s\S]*?<udt:DateTimeString[^>]*>(\d{8})<\/udt:DateTimeString>/,
    );
    expect(delivery?.[1]).toBe('20260531');
  });
});
