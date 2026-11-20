// Fachkatalog: BWA-TAX-ESTIMATE-001
import { describe, it, expect } from 'vitest';
import {
  einkommensteuerGrundtarif,
  bwaCalendarYear,
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
    expect(() => estimateTaxes({ ...base, taxYear: 2027 })).toThrow('2025 und 2026');
  });
});

describe('estimateTaxes — Einzelunternehmen § 35 EStG', () => {
  it('bemisst ESt auf das volle Ergebnis (§ 4 Abs. 5b) und rechnet GewSt nach § 35 an', () => {
    const r = estimateTaxes(base);
    // Messbetrag = (100000 - 24500) * 3,5 % = 2642,5; GewSt = 2642,5 * 400 % = 10570.
    expect(r.gewerbesteuer).toBe(10_570);
    // § 35: Anrechnung = min(4 × 2642,5 = 10570, GewSt 10570, tarifliche ESt).
    // Die ESt darf NICHT auf (Ergebnis − GewSt) bemessen sein.
    const estOhneAnrechnung = einkommensteuerGrundtarif(base.taxYear, base.result)!;
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
    const estVollTariflich = einkommensteuerGrundtarif(base.taxYear, base.result)!;
    expect(r.einkommensteuerSchaetzung!).toBe(estVollTariflich);
    // Und höher als beim gewerblichen Einzelunternehmen mit Anrechnung.
    expect(r.einkommensteuerSchaetzung!).toBeGreaterThan(
      estimateTaxes(base).einkommensteuerSchaetzung!,
    );
  });
});

describe('BWA-TAX-ESTIMATE-001: Geltungsbereich der Jahresschätzung', () => {
  // § 23 Abs. 1 KStG: https://www.gesetze-im-internet.de/kstg_1977/__23.html
  it.each([2024, 2027, 2028, 2032])(
    'liefert für die GmbH im Jahr %i keine Teil- oder Gesamtsumme',
    (taxYear) => {
      expect(() => estimateTaxes({ ...base, taxYear, legalForm: 'GMBH' })).toThrow('2025 und 2026');
    },
  );

  it.each([2025, 2026])(
    'berechnet für die GmbH im unterstützten Jahr %i KSt und SolZ',
    (taxYear) => {
      expect(estimateTaxes({ ...base, taxYear, legalForm: 'GMBH' })).toMatchObject({
        gewerbesteuer: 14_000,
        koerperschaftsteuer: 15_000,
        solidaritaetszuschlag: 825,
        gesamt: 29_825,
      });
    },
  );

  // Erhebungsjahr der Hebesatzänderung: https://www.gesetze-im-internet.de/gewstg/__36.html
  it.each([Number.NaN, Infinity, -1, 0, 199, 901])(
    'weist den Modell-Hebesatz %s zurück',
    (rate) => {
      expect(() => estimateTaxes({ ...base, gewerbesteuerHebesatzPct: rate })).toThrow('Hebesatz');
    },
  );
  it.each([200, 411, 900])(
    'akzeptiert den unterstützten Hebesatz %i einschließlich der Ränder',
    (rate) => {
      expect(estimateTaxes({ ...base, gewerbesteuerHebesatzPct: rate }).gewerbesteuer).toBe(
        Math.round(2642.5 * (rate / 100)),
      );
    },
  );
  it('ignoriert bei ausschließlich freiberuflicher Tätigkeit den entbehrlichen Hebesatz', () => {
    expect(
      estimateTaxes({ ...base, isFreiberufler: true, gewerbesteuerHebesatzPct: NaN }).gewerbesteuer,
    ).toBe(0);
  });
  it('verwirft widersprüchliche Kapitalgesellschaftsangaben', () => {
    expect(() => estimateTaxes({ ...base, legalForm: 'GMBH', isFreiberufler: true })).toThrow(
      'widersprechen',
    );
    expect(() =>
      estimateTaxes({ ...base, legalForm: 'GMBH', isPersonengesellschaft: true }),
    ).toThrow('widersprechen');
  });
  it.each([
    ['2025-01-01', '2025-12-31', 2025],
    ['2026-03-01', '2026-03-31', null],
    ['2026-01-01', '2026-09-30', null],
    ['2025-07-01', '2026-06-30', null],
    ['2025-01-01', '2026-12-31', null],
  ] as const)('prüft die tatsächlichen BWA-Grenzen %s bis %s', (from, to, expected) => {
    expect(bwaCalendarYear(new Date(from), new Date(to))).toBe(expected);
  });
});
