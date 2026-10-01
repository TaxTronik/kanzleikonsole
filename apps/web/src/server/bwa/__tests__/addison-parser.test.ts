// Fachkatalog: BWA-IMPORT-MAPPING-001 — regression evidence for the compact CSV variant.
import { describe, expect, it } from 'vitest';
import { parseAddisonBwaCompactCsv, parseAddisonBwaCsv } from '../addison-parser';

describe.each([
  [
    'Langform',
    (period: string) =>
      parseAddisonBwaCsv(`Nummer;Bezeichnung;Zeitraum\n;;${period}\n1990;Summe Erlöse;100,00`),
  ],
  [
    'Kompaktform',
    (period: string) => parseAddisonBwaCompactCsv(`;Summe Erlöse\nZeitraum ${period};100,00`),
  ],
] as const)('Addison %s: eindeutige und gueltige Perioden', (_variant, parse) => {
  it('bewahrt einen verschobenen Dreimonatsbereich ohne Kalenderquartals-Kollision', () => {
    const shifted = parse('02.26-04.26').periods[0]!;
    const quarter = parse('04.26-06.26').periods[0]!;
    expect(shifted).toMatchObject({
      type: 'YEAR',
      periodKey: '2026-02-2026-04',
      fromDate: new Date('2026-02-01T00:00:00Z'),
      toDate: new Date('2026-04-30T00:00:00Z'),
    });
    expect(quarter).toMatchObject({ type: 'QUARTER', periodKey: '2026-Q2' });
    expect(shifted.periodKey).not.toBe(quarter.periodKey);
  });

  it.each(['00.26-00.26', '13.26-13.26', '01.26-13.26', '06.26-05.26', '12.26-01.26'])(
    'verwirft den ungueltigen Bereich %s statt das Datum zu normalisieren',
    (period) => {
      expect(parse(period).periods).toEqual([]);
    },
  );

  it('bewahrt einen gueltigen jahresuebergreifenden Bereich und den Schalttag', () => {
    expect(parse('12.23-02.24').periods[0]).toMatchObject({
      periodKey: '2023-12-2024-02',
      fromDate: new Date('2023-12-01T00:00:00Z'),
      toDate: new Date('2024-02-29T00:00:00Z'),
    });
  });
});

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
