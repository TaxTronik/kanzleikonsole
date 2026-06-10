import { describe, it, expect } from 'vitest';
import { generateXRechnungCii } from '../xrechnung';
// Geteilte Fixture (Mischsätze 19/7/0 %) — auch Input der KoSIT-Validierung
// im CI-Job `e-rechnung` (cli/generate-sample.ts).
import { SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER } from '../sample-fixture';

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
    // BT-72 Liefer-/Leistungsdatum (BR-DE-TMP-32) — Konvention: = Rechnungsdatum
    expect(xml).toContain('<ram:ActualDeliverySupplyChainEvent>');
    expect(xml).toContain('20260610');
  });
});
