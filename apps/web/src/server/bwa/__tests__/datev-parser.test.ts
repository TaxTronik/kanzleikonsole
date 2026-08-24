// Fachkatalog: BWA-IMPORT-MAPPING-001
// =============================================================================
// Tests fuer den DATEV-BWA-Import.
//
// Die Fixture bildet den Aufbau eines echten Vorjahresvergleichs nach: Kanzlei-
// Header ueber der Tabelle, Monats- und Jahresspalten, Sub-Konto-Zeilen, die
// nicht importiert werden duerfen, sowie Betraege als Formel und als Text.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseDatevBwaXlsx } from '../datev-parser';

interface Row {
  cells: (string | number | null)[];
  index: number;
}

function buildBwaXlsx(rows: Row[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();

  const body = rows
    .map(({ cells, index }) => {
      const encoded = cells
        .map((value, column) => {
          if (value === null) return '';
          const ref = `${columnName(column)}${index}`;
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          let si = sharedIndex.get(value);
          if (si === undefined) {
            si = shared.length;
            sharedIndex.set(value, si);
            shared.push(value);
          }
          return `<c r="${ref}" t="s"><v>${si}</v></c>`;
        })
        .join('');
      return `<row r="${index}">${encoded}</row>`;
    })
    .join('');

  return zipSync({
    'xl/workbook.xml': strToU8(
      `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="BWA" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<sst>${shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`,
    ),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${body}</sheetData></worksheet>`),
  });
}

function columnName(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

const FIXTURE: Row[] = [
  { index: 1, cells: ['Musterkanzlei GmbH — BWA Vorjahresvergleich'] },
  {
    index: 2,
    cells: [
      'Zeile',
      'Konto',
      'Bezeichnung',
      'Dez/2025',
      'Dez/2024',
      'Veränderung',
      'in %',
      'Jan/2025 - Dez/2025',
      'Jan/2024 - Dez/2024',
    ],
  },
  { index: 3, cells: ['1020', null, 'Umsatzerlöse', 15000, 12000, 3000, 25, 180000, 150000] },
  // Sub-Konto-Detail: Spalte A leer -> darf nicht importiert werden.
  { index: 4, cells: [null, '8400', 'Erlöse 19% USt', 15000, 12000, 3000, 25, 180000, 150000] },
  { index: 5, cells: [] },
  {
    index: 6,
    cells: ['1051', null, 'Mat./Wareneinkauf', -4000, -3500, -500, 14.3, -48000, -42000],
  },
  // Betrag als deutscher Zahlentext, wie ihn manche Exporte liefern.
  {
    index: 7,
    cells: ['1380', null, 'Personalkosten', '-2.500,50', -2400, -100.5, 4.2, -30006, -28800],
  },
];

describe('parseDatevBwaXlsx', () => {
  it('importiert nur Hauptpositionen und erkennt Monats- und Jahresspalten', async () => {
    const result = await parseDatevBwaXlsx(buildBwaXlsx(FIXTURE));

    expect(result.warnings).toEqual([]);
    expect(result.periods.map((p) => p.periodKey)).toEqual(['2025-12', '2024-12', '2025', '2024']);

    const dez2025 = result.periods[0]!;
    expect(dez2025.type).toBe('MONTH');
    expect(dez2025.fromDate.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(dez2025.toDate.toISOString()).toBe('2025-12-31T00:00:00.000Z');
    expect(dez2025.positions).toEqual([
      { number: 1020, label: 'Umsatzerlöse', amount: 15000, sharePct: null },
      { number: 1051, label: 'Mat./Wareneinkauf', amount: -4000, sharePct: null },
      { number: 1380, label: 'Personalkosten', amount: -2500.5, sharePct: null },
    ]);

    const jahr2025 = result.periods[2]!;
    expect(jahr2025.type).toBe('YEAR');
    expect(jahr2025.label).toBe('Jahr 2025');
    expect(jahr2025.positions.map((p) => p.amount)).toEqual([180000, -48000, -30006]);
  });

  it('erkennt den Maerz in beiden deutschen Schreibweisen', async () => {
    for (const maerz of ['Mär', 'Mrz']) {
      const result = await parseDatevBwaXlsx(
        buildBwaXlsx([
          { index: 1, cells: ['Zeile', 'Konto', 'Bezeichnung', `Jan/2025 - ${maerz}/2025`] },
          { index: 2, cells: ['1020', null, 'Umsatzerlöse', 42000] },
        ]),
      );
      expect(result.periods.map((p) => p.periodKey)).toEqual(['2025-01-2025-03']);
      expect(result.periods[0]!.toDate.toISOString()).toBe('2025-03-31T00:00:00.000Z');
    }
  });

  it('meldet eine fehlende Header-Zeile statt leerer Perioden', async () => {
    const result = await parseDatevBwaXlsx(
      buildBwaXlsx([{ index: 1, cells: ['Irgendein anderer Export'] }]),
    );
    expect(result.periods).toEqual([]);
    expect(result.warnings).toEqual(['Header-Zeile (Spalte A = "Zeile") nicht gefunden.']);
  });

  it('meldet fehlende Datumsspalten', async () => {
    const result = await parseDatevBwaXlsx(
      buildBwaXlsx([
        { index: 1, cells: ['Zeile', 'Konto', 'Bezeichnung', 'Summe', 'Anteil'] },
        { index: 2, cells: ['1020', null, 'Umsatzerlöse', 1, 2] },
      ]),
    );
    expect(result.warnings).toEqual(['Keine Datums-Spalten im Header erkannt.']);
  });
});
