import { describe, expect, it } from 'vitest';
import { buildProjectionSnapshot } from '../projection-snapshot';
import { linearSeasonalProjection, type YearProjection } from '@/server/bwa/projection';

const datev = [
  [1020, 1000],
  [1060, 200],
  [1090, 25],
  [1100, 400],
  [1240, 50],
  [1280, 600],
  [1330, 20],
  [1345, 245],
].map(([number, amount]) => ({ number: number!, amount: amount! }));
const period = {
  source: 'DATEV' as const,
  periodKey: '2026-Q2',
  periodType: 'QUARTER' as const,
  fromDate: new Date('2026-01-01'),
  toDate: new Date('2026-06-30'),
  positions: datev,
};

describe('BWA-PROJECTION-001: Snapshot erhält unabhängige Achsen der Engine', () => {
  it('verwendet die DATEV-Einzelpositionen und überträgt den gemeinsamen Jahresfaktor', () => {
    const projection = linearSeasonalProjection([period], 2026);
    expect(buildProjectionSnapshot(projection, [period])).toMatchObject({
      revenue: 2000,
      costs: 1600,
      personnelCost: 800,
      material: 400,
      depreciation: 100,
      otherCosts: 300,
      otherIncome: 90,
      resultBeforeTax: 490,
      taxes: 147,
      resultAfterTax: 343,
    });
  });
  it('schließt bei fehlenden Einzelpositionen weder Kosten noch sonstige Erträge durch Restgrößen', () => {
    const incomplete = {
      ...period,
      positions: datev
        .filter((p) => ![1060, 1240, 1330, 1345].includes(p.number))
        .concat([
          { number: 1051, amount: 1000 },
          { number: 1300, amount: 225 },
        ]),
    };
    const projection = linearSeasonalProjection([incomplete], 2026);
    expect(buildProjectionSnapshot(projection, [incomplete])).toMatchObject({
      costs: 1600,
      material: null,
      depreciation: null,
      otherCosts: null,
      otherIncome: null,
      resultBeforeTax: null,
      taxes: null,
      resultAfterTax: null,
    });
  });
  it('rekonstruiert ein eigenständiges Ergebnis nicht aus den verfügbaren Planachsen', () => {
    const changed = {
      ...period,
      positions: datev.map((p) => (p.number === 1345 ? { ...p, amount: 345 } : p)),
    };
    const snapshot = buildProjectionSnapshot(linearSeasonalProjection([changed], 2026), [changed]);
    expect(snapshot).toMatchObject({
      revenue: 2000,
      costs: 1600,
      otherIncome: 90,
      resultBeforeTax: 690,
      taxes: 207,
      resultAfterTax: 483,
    });
  });
  it('mischt keine YTD-Teilwerte in eine reine Trendprojektion', () => {
    const projection = {
      ...linearSeasonalProjection([period], 2026)!,
      strategy: 'trend-regression',
    } as YearProjection;
    expect(buildProjectionSnapshot(projection, [period])).toMatchObject({
      costs: 1600,
      material: null,
      depreciation: null,
      otherIncome: null,
      otherCosts: null,
      resultBeforeTax: 490,
    });
  });
  it('erhält ausdrücklich vorhandene Nullbeträge', () => {
    const zero = { ...period, positions: datev.map((p) => ({ ...p, amount: 0 })) };
    expect(buildProjectionSnapshot(linearSeasonalProjection([zero], 2026), [zero])).toMatchObject({
      revenue: 0,
      costs: 0,
      material: 0,
      depreciation: 0,
      otherCosts: 0,
      otherIncome: 0,
      resultBeforeTax: 0,
      taxes: 0,
      resultAfterTax: 0,
    });
  });
  it('erfindet für MANUAL keine DATEV- oder Addison-Untergliederung', () => {
    const manual = { ...period, source: 'MANUAL' as const };
    expect(
      buildProjectionSnapshot(linearSeasonalProjection([manual], 2026), [manual]),
    ).toMatchObject({
      material: null,
      depreciation: null,
      otherIncome: null,
      otherCosts: null,
    });
  });
  it('liefert ohne Hochrechnung keine Vergleichsspalte', () => {
    expect(buildProjectionSnapshot(null, [period])).toBeNull();
  });
});
