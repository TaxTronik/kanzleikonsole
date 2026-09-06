// Fachkatalog: BWA-IMPORT-MAPPING-001 — regression evidence for the compact CSV variant.
import { describe, expect, it } from 'vitest';
import { parseAddisonBwaCompactCsv } from '../addison-parser';

describe('Addison compact CSV', () => {
  it('preserves German signed amounts, known column mapping and quarter boundaries', () => {
    const parsed = parseAddisonBwaCompactCsv(
      [
        'Kurzfristige Erfolgsrechnung',
        'per März 2026',
        ';Summe Erlöse;Betriebseinnahmen;Summe Personalkosten;Summe der Kosten;Vorläufiges Ergebnis;unbekannt',
        'Quartal 01.26-03.26;100.000,00;119.000,00;50.000,00;110.000,00;-10.000,00;999',
        'Vorjahr 01.25-03.25;90.000,00;;;;8.000,00;999',
      ].join('\n'),
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.periods).toHaveLength(2);
    expect(parsed.periods[0]).toEqual({
      type: 'QUARTER',
      periodKey: '2026-Q1',
      label: 'Q1 2026',
      fromDate: new Date('2026-01-01T00:00:00Z'),
      toDate: new Date('2026-03-31T00:00:00Z'),
      positions: [
        { number: 1990, label: 'Summe Erlöse', amount: 100000, sharePct: null },
        { number: 2995, label: 'Betriebseinnahmen', amount: 119000, sharePct: null },
        { number: 3030, label: 'Personalkosten', amount: 50000, sharePct: null },
        { number: 3150, label: 'Summe der Kosten', amount: 110000, sharePct: null },
        { number: 3250, label: 'Vorläufiges Ergebnis', amount: -10000, sharePct: null },
      ],
    });
    expect(parsed.periods[1]!.positions.map((position) => position.amount)).toEqual([90000, 8000]);
  });

  it('warns when no known columns can be mapped', () => {
    expect(parseAddisonBwaCompactCsv(';Kontostand\nQuartal 01.26-03.26;999')).toEqual({
      periods: [],
      warnings: ['Keine bekannten Spalten erkannt (Summe Erlöse, Personalkosten, …).'],
    });
  });
});
