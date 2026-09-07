import { describe, expect, it } from 'vitest';
import { computeLiquidity, type PeriodInput } from '../liquidity';

function quarter(revenue: number, result: number, personnel: number): PeriodInput {
  return {
    periodType: 'QUARTER',
    periodKey: '2026-Q1',
    fromDate: new Date('2026-01-01'),
    toDate: new Date('2026-03-31'),
    positions: [
      { number: 1990, amount: revenue },
      { number: 3250, amount: result },
      { number: 3030, amount: personnel },
      { number: 3100, amount: 3000 },
    ],
  };
}

describe('liquidity proxy regression', () => {
  it('BWA-IMPORT-MAPPING-001: addiert DATEV-Abschreibungen 1240 statt Werbe-/Reisekosten 1200', () => {
    const current = quarter(0, 0, 0);
    current.positions = [
      { number: 1020, amount: 10000 },
      { number: 1200, amount: 6000 },
      { number: 1240, amount: 200 },
      { number: 1380, amount: -500 },
    ];
    expect(computeLiquidity(current, null)).toMatchObject({
      cashflowProxy: -300,
      cashflowMonthly: -100,
      warning:
        'Negativer operativer Cashflow — wir empfehlen eine kurzfristige Liquiditätsplanung mit Ihrer Kanzlei.',
    });
  });

  it('BWA-IMPORT-MAPPING-001: unterscheidet fehlende Abschreibungen von echten null Euro', () => {
    const current = quarter(0, 0, 0);
    current.positions = [
      { number: 1380, amount: 500 },
      { number: 1200, amount: 100 },
    ];
    expect(computeLiquidity(current, null)).toMatchObject({
      cashflowProxy: null,
      cashflowMonthly: null,
    });
    current.positions.push({ number: 1240, amount: 0 });
    expect(computeLiquidity(current, null)).toMatchObject({
      cashflowProxy: 500,
      cashflowMonthly: 500 / 3,
    });
  });

  it('keeps quarterly cashflow, positive revenue ratios and warning priority', () => {
    const result = computeLiquidity(quarter(100000, 10000, 56000), quarter(100000, 8000, 50000));
    expect(result).toEqual({
      monthsCovered: 3,
      cashflowProxy: 13000,
      cashflowMonthly: 13000 / 3,
      marginPct: 10,
      personnelRatioPct: expect.closeTo(56, 8),
      marginTrend: 'up',
      personnelTrend: 'up',
      warning: 'Personalkostenquote über 55 % und steigend — Liquiditätspuffer prüfen.',
    });
    expect(
      computeLiquidity(quarter(100000, -6000, 60000), quarter(100000, 10000, 50000)).warning,
    ).toBe(
      'Negativer operativer Cashflow — wir empfehlen eine kurzfristige Liquiditätsplanung mit Ihrer Kanzlei.',
    );
  });

  it.each([0, -100])(
    'keeps ratios and trends unavailable for nonpositive revenue %s',
    (revenue) => {
      expect(
        computeLiquidity(quarter(revenue, 0, 100), quarter(100000, 10000, 50000)),
      ).toMatchObject({
        marginPct: null,
        personnelRatioPct: null,
        marginTrend: null,
        personnelTrend: null,
      });
    },
  );
});
