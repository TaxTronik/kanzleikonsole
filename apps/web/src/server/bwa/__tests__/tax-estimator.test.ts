import { describe, it, expect } from 'vitest';
import { estimateTaxes, type TaxEstimationInput } from '../tax-estimator';

const base: TaxEstimationInput = {
  legalForm: 'EINZELUNTERNEHMEN',
  result: 100_000,
  revenue: null,
  inputVat: null,
  vatPaid: null,
  gewerbesteuerHebesatzPct: 400,
  isPersonengesellschaft: false,
};

describe('estimateTaxes — Einzelunternehmen § 35 EStG', () => {
  it('bemisst ESt auf das volle Ergebnis (§ 4 Abs. 5b) und rechnet GewSt nach § 35 an', () => {
    const r = estimateTaxes(base);
    // Messbetrag = (100000 - 24500) * 3,5 % = 2642,5; GewSt = 2642,5 * 400 % = 10570.
    expect(r.gewerbesteuer).toBe(10_570);
    // § 35: Anrechnung = min(4 × 2642,5 = 10570, GewSt 10570, tarifliche ESt).
    // Die ESt darf NICHT auf (Ergebnis − GewSt) bemessen sein.
    const estOhneAnrechnung = estimateTaxes({ ...base, gewerbesteuerHebesatzPct: 0 }).einkommensteuerSchaetzung!;
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
    const estVollTariflich = estimateTaxes({ ...base, gewerbesteuerHebesatzPct: 0 })
      .einkommensteuerSchaetzung!;
    expect(r.einkommensteuerSchaetzung!).toBe(estVollTariflich);
    // Und höher als beim gewerblichen Einzelunternehmen mit Anrechnung.
    expect(r.einkommensteuerSchaetzung!).toBeGreaterThan(estimateTaxes(base).einkommensteuerSchaetzung!);
  });
});
