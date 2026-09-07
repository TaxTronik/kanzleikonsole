// Fachkatalog: BWA-IMPORT-MAPPING-001, BWA-PROJECTION-001, BWA-TAX-ESTIMATE-001.
import { describe, expect, it } from 'vitest';
import { computeBwaKpis } from '../addison-parser';
import {
  linearSeasonalProjection,
  trendRegressionProjection,
  type PeriodInput,
} from '../projection';
import { estimateTaxes } from '../tax-estimator';

// Synthetic BWA 01 following the separately named positions in the DATEV
// Planungscockpit sample referenced by BWA-IMPORT-MAPPING-001. Stock changes,
// own work and neutral expense deliberately differ from sales/operating profit.
const source = [
  { number: 1020, amount: 1000 },
  { number: 1040, amount: 100 },
  { number: 1045, amount: 50 },
  { number: 1051, amount: 1150 },
  { number: 1060, amount: 200 },
  { number: 1090, amount: 25 },
  { number: 1100, amount: 400 },
  { number: 1280, amount: 600 },
  { number: 1300, amount: 375 },
  { number: 1320, amount: 75 },
  { number: 1330, amount: 20 },
  { number: 1345, amount: 320 },
  { number: 1380, amount: 250 },
];

function period(year: number, positions = source): PeriodInput {
  return {
    periodType: 'QUARTER',
    periodKey: `${year}-H1`,
    fromDate: new Date(Date.UTC(year, 0, 1)),
    toDate: new Date(Date.UTC(year, 5, 30)),
    positions,
  };
}

describe('DATEV-Kennzahlen: unterschiedliche fachliche Positionen bleiben getrennt', () => {
  it('verwendet Umsatzerlöse für Umsatz und Quoten, direkte Kosten einschließlich Material', () => {
    expect(computeBwaKpis(source)).toEqual({
      revenue: 1000,
      costs: 800,
      result: 250,
      resultBeforeTax: 320,
      resultMargin: 0.25,
      personnelCost: 400,
      personnelRatio: 0.4,
    });
  });

  it('leitet Kosten nur aus vollständiger Gesamtleistungs-/Erlös-/Betriebsergebnisbasis ab', () => {
    expect(computeBwaKpis(source.filter((p) => p.number !== 1280)).costs).toBe(800);
  });

  it('nutzt Gesamtleistung oder Betriebsergebnis nicht als Ersatz fehlender Umsatz-/Vorsteuerzeilen', () => {
    const incomplete = source.filter((p) => p.number !== 1020 && p.number !== 1345);
    expect(computeBwaKpis(incomplete)).toMatchObject({
      revenue: null,
      resultBeforeTax: null,
      resultMargin: null,
      personnelRatio: null,
      costs: 800,
      result: 250,
    });
  });

  it('erfindet fehlende Kostenbestandteile nicht als Null', () => {
    const incomplete = source.filter((p) => p.number !== 1280 && p.number !== 1090);
    expect(computeBwaKpis(incomplete).costs).toBeNull();
  });

  it('bewahrt tatsächlich vorhandene Nullwerte', () => {
    expect(computeBwaKpis(source.map((p) => ({ ...p, amount: 0 })))).toMatchObject({
      revenue: 0,
      costs: 0,
      resultBeforeTax: 0,
      resultMargin: null,
      personnelRatio: null,
    });
  });

  it('lässt den bestehenden Addison-Kennzahlpfad unverändert', () => {
    expect(
      computeBwaKpis([
        { number: 1990, amount: 1000 },
        { number: 3150, amount: 800 },
        { number: 3250, amount: 200 },
        { number: 3030, amount: 400 },
      ]),
    ).toEqual({
      revenue: 1000,
      costs: 800,
      result: 200,
      resultBeforeTax: 200,
      resultMargin: 0.2,
      personnelCost: 400,
      personnelRatio: 0.4,
    });
  });

  it('setzt Bestandsänderungen und Eigenleistungen nicht als Umsätze in der USt-Pauschale an', () => {
    const kpis = computeBwaKpis(source);
    const tax = estimateTaxes({
      taxYear: 2026,
      legalForm: 'GMBH',
      result: kpis.resultBeforeTax!,
      revenue: kpis.revenue,
      inputVat: 0,
      vatPaid: 0,
      gewerbesteuerHebesatzPct: 400,
    });
    expect(tax.ustZahllast).toBe(190);
  });
});

describe('DATEV-Projektion: keine ersetzten Ergebnis- oder Umsatzbasen', () => {
  it('projiziert Umsatzerlöse, betriebliche Kosten und Vorsteuerergebnis getrennt', () => {
    expect(linearSeasonalProjection([period(2026)], 2026)).toMatchObject({
      revenue: { estimate: 2000 },
      costs: { estimate: 1600 },
      result: { estimate: 640 },
    });
  });

  it('liefert bei fehlender 1345 weder lineare Ergebnis- noch Steuerpauschale', () => {
    const incomplete = source.filter((p) => p.number !== 1345);
    expect(linearSeasonalProjection([period(2026, incomplete)], 2026)).toMatchObject({
      result: null,
      taxes: null,
      resultAfterTax: null,
    });
  });

  it('liefert bei fehlender 1345 auch im Vorjahrestrend keine Ergebnis-/Steuerachse', () => {
    const incomplete = source.filter((p) => p.number !== 1345);
    const years = [2024, 2025].map((year) => ({
      ...period(year, incomplete),
      periodType: 'YEAR' as const,
      toDate: new Date(Date.UTC(year, 11, 31)),
    }));
    expect(trendRegressionProjection(years, 2026)).toMatchObject({
      result: null,
      taxes: null,
      resultAfterTax: null,
    });
  });
});
