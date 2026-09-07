// Fachkatalog: BWA-IMPORT-MAPPING-001, BWA-PROJECTION-001.
import { describe, expect, it } from 'vitest';
import { computeBwaPlanBasis } from '../plan-basis';

const datev = [
  { number: 1020, amount: 1000 },
  { number: 1040, amount: 0 },
  { number: 1045, amount: 0 },
  { number: 1051, amount: 1000 },
  { number: 1060, amount: 200 },
  { number: 1090, amount: 25 },
  { number: 1100, amount: 400 },
  { number: 1240, amount: 50 },
  { number: 1280, amount: 600 },
  { number: 1300, amount: 225 },
  { number: 1320, amount: 0 },
  { number: 1330, amount: 20 },
  { number: 1345, amount: 245 },
  { number: 1380, amount: 170 },
];

describe('BWA-Planbasis: vorhandene Achsen statt erfundener Restgrößen', () => {
  it('deutet MANUAL ohne dokumentierte Positionszuordnung nicht als Importschema', () => {
    const basis = computeBwaPlanBasis(datev, 'MANUAL');
    expect(basis.canApply).toBe(false);
    expect(basis.unavailableReason).toContain('manuell');
    expect(basis.revenue).toBeNull();
    expect(basis.otherIncome).toBeNull();
    expect(basis.resultBeforeTax).toBeNull();
  });

  it('übernimmt eine vollständige darstellbare DATEV-Basis mit echten Einzelachsen', () => {
    expect(computeBwaPlanBasis(datev, 'DATEV')).toEqual({
      revenue: 1000,
      costs: 800,
      resultBeforeTax: 245,
      result: 170,
      personnelCost: 400,
      material: 200,
      depreciation: 50,
      otherIncome: 45,
      canApply: true,
      unavailableReason: null,
    });
  });

  it.each([1040, 1045, 1320])(
    'weist nicht darstellbare oder fehlende Position %s zurück',
    (number) => {
      for (const positions of [
        datev.map((p) => (p.number === number ? { ...p, amount: 100 } : p)),
        datev.filter((p) => p.number !== number),
      ]) {
        const basis = computeBwaPlanBasis(positions, 'DATEV');
        expect(basis.canApply).toBe(false);
        expect(basis.unavailableReason).toContain('manuell');
        expect(basis.otherIncome).toBe(45);
      }
    },
  );

  it.each([1020, 1100, 1240, 1330, 1345])(
    'ersetzt fehlende Position %s nicht mit Null',
    (number) => {
      expect(
        computeBwaPlanBasis(
          datev.filter((p) => p.number !== number),
          'DATEV',
        ).canApply,
      ).toBe(false);
    },
  );

  it('erfindet keinen sonstigen Ertrag, um einen Ergebnisunterschied zu schließen', () => {
    const basis = computeBwaPlanBasis(
      datev.map((p) => (p.number === 1345 ? { ...p, amount: 300 } : p)),
      'DATEV',
    );
    expect(basis.canApply).toBe(false);
    expect(basis.otherIncome).toBe(45);
    expect(basis.unavailableReason).toContain('ausgewiesene Ergebnis');
  });

  it('akzeptiert explizite Nullwerte und prüft die Identität centgenau', () => {
    const zeros = datev.map((p) => ({ ...p, amount: 0 }));
    expect(computeBwaPlanBasis(zeros, 'DATEV').canApply).toBe(true);
    const decimals = zeros.map((p) => ({
      ...p,
      amount: p.number === 1020 ? 0.3 : p.number === 1280 ? 0.1 : p.number === 1345 ? 0.2 : 0,
    }));
    expect(computeBwaPlanBasis(decimals, 'DATEV').canApply).toBe(true);
    expect(
      computeBwaPlanBasis(
        decimals.map((p) => (p.number === 1345 ? { ...p, amount: 0.21 } : p)),
        'DATEV',
      ).canApply,
    ).toBe(false);
  });

  it('erhält vollständige Addison-Achsen und kennzeichnet unvollständige kompakte Basen', () => {
    const addison = [
      { number: 1990, amount: 1000 },
      { number: 3150, amount: 800 },
      { number: 3250, amount: 250 },
      { number: 3030, amount: 400 },
      { number: 3010, amount: 200 },
      { number: 3100, amount: 50 },
      { number: 1010, amount: 50 },
    ];
    expect(computeBwaPlanBasis(addison, 'ADDISON')).toMatchObject({
      canApply: true,
      otherIncome: 50,
    });
    const incomplete = computeBwaPlanBasis(
      addison.filter((p) => p.number !== 1010),
      'ADDISON',
    );
    expect(incomplete.canApply).toBe(false);
    expect(incomplete.otherIncome).toBeNull();
  });
});
