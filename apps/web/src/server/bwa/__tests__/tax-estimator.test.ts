// Fachkatalog: BWA-TAX-ESTIMATE-001
import { describe, it, expect } from 'vitest';
import {
  einkommensteuerGrundtarif,
  estimateTaxes,
  type TaxEstimationInput,
} from '../tax-estimator';

const base: TaxEstimationInput = {
  legalForm: 'EINZELUNTERNEHMEN',
  taxYear: 2026,
  result: 100_000,
  revenue: null,
  inputVat: null,
  vatPaid: null,
  gewerbesteuerHebesatzPct: 400,
  isPersonengesellschaft: false,
};

it('BWA-TAX-ESTIMATE-001: lehnt ein bekanntes Nachsteuerergebnis als Schätzungsbasis ab', () => {
  expect(() => estimateTaxes({ ...base, result: 60_000, resultIsAfterTax: true })).toThrow(
    'Ergebnis vor Steuern',
  );
});

describe('§ 32a EStG — jahrgangsbezogener Grundtarif', () => {
  it('verwendet 2026 Grundfreibetrag und amtliche lineare Zone', () => {
    expect(einkommensteuerGrundtarif(2026, 12_348)).toBe(0);
    expect(einkommensteuerGrundtarif(2026, 100_000)).toBe(30_864);
  });

  it('behält 2025 für historische BWA-Perioden getrennt', () => {
    expect(einkommensteuerGrundtarif(2025, 100_000)).toBe(31_088);
  });

  it('wendet keinen veralteten Tarif auf unbekannte Jahre an', () => {
    expect(einkommensteuerGrundtarif(2027, 100_000)).toBeNull();
    const result = estimateTaxes({ ...base, taxYear: 2027 });
    expect(result.einkommensteuerSchaetzung).toBeNull();
    expect(result.disclaimers.join(' ')).toContain('kein verifizierter');
  });
});

describe('estimateTaxes — Einzelunternehmen § 35 EStG', () => {
  it('bemisst ESt auf das volle Ergebnis (§ 4 Abs. 5b) und rechnet GewSt nach § 35 an', () => {
    const r = estimateTaxes(base);
    // Messbetrag = (100000 - 24500) * 3,5 % = 2642,5; GewSt = 2642,5 * 400 % = 10570.
    expect(r.gewerbesteuer).toBe(10_570);
    // § 35: Anrechnung = min(4 × 2642,5 = 10570, GewSt 10570, tarifliche ESt).
    // Die ESt darf NICHT auf (Ergebnis − GewSt) bemessen sein.
    const estOhneAnrechnung = estimateTaxes({
      ...base,
      gewerbesteuerHebesatzPct: 0,
    }).einkommensteuerSchaetzung!;
    // Ohne GewSt (Hebesatz 0) gibt es keine Anrechnung → das ist die volle
    // tarifliche ESt auf 100.000. Mit Hebesatz 400 muss die ESt niedriger sein.
    expect(r.einkommensteuerSchaetzung!).toBeLessThan(estOhneAnrechnung);
    // Anrechnung ist auf die tatsächliche GewSt gedeckelt.
    expect(estOhneAnrechnung - r.einkommensteuerSchaetzung!).toBeLessThanOrEqual(r.gewerbesteuer);
  });

  it('ESt nie negativ (Anrechnung auf tarifliche ESt gedeckelt)', () => {
    const r = estimateTaxes({ ...base, result: 20_000 });
    expect(r.einkommensteuerSchaetzung!).toBeGreaterThanOrEqual(0);
  });

  it('rundet den Gewerbeertrag vor dem Freibetrag auf volle 100 Euro ab', () => {
    const r = estimateTaxes({ ...base, result: 100_099 });
    expect(r.gewerbesteuerBemessung).toBe(75_500);
    expect(r.gewerbesteuer).toBe(10_570);
    expect(r.disclaimers.join(' ')).toContain('Hinzurechnungen');
  });
});

describe('estimateTaxes — Freiberufler § 18 EStG (keine GewSt)', () => {
  it('setzt keine Gewerbesteuer an und rechnet nichts nach § 35 an', () => {
    const r = estimateTaxes({ ...base, isFreiberufler: true });
    expect(r.gewerbesteuer).toBe(0);
    expect(r.gewerbesteuerBemessung).toBe(0);
    expect(r.gewerbesteuerFreibetrag).toBe(0);
    // Volle tarifliche ESt: ohne GewSt gibt es keine § 35-Anrechnung. Muss
    // identisch zum Einzelunternehmen mit Hebesatz 0 sein (dort ebenfalls
    // GewSt 0 → Anrechnung 0).
    const estVollTariflich = estimateTaxes({
      ...base,
      gewerbesteuerHebesatzPct: 0,
    }).einkommensteuerSchaetzung!;
    expect(r.einkommensteuerSchaetzung!).toBe(estVollTariflich);
    // Und höher als beim gewerblichen Einzelunternehmen mit Anrechnung.
    expect(r.einkommensteuerSchaetzung!).toBeGreaterThan(
      estimateTaxes(base).einkommensteuerSchaetzung!,
    );
  });
});
