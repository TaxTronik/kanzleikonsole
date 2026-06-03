import { describe, it, expect } from 'vitest';
import { applyRowCap, MAX_EXPORT_ROWS, toCsv, escapeCsvCell, type CsvColumn } from '../csv';

describe('applyRowCap — Trunkierungs-Erkennung', () => {
  it('truncated=false, wenn UNTER dem Limit', () => {
    const { rows, truncated } = applyRowCap([1, 2, 3], 5);
    expect(truncated).toBe(false);
    expect(rows).toEqual([1, 2, 3]);
  });

  it('truncated=false, wenn EXAKT am Limit (es existieren nicht mehr)', () => {
    const { rows, truncated } = applyRowCap([1, 2, 3, 4, 5], 5);
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(5);
  });

  it('truncated=true + auf max getrimmt, wenn max+1 gelesen (es existieren mehr)', () => {
    // Die Route liest take: max + 1 → 6 Zeilen bei max=5 signalisiert „mehr da".
    const { rows, truncated } = applyRowCap([1, 2, 3, 4, 5, 6], 5);
    expect(truncated).toBe(true);
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  it('Default-Limit ist MAX_EXPORT_ROWS', () => {
    const under = applyRowCap(new Array(MAX_EXPORT_ROWS).fill(0));
    expect(under.truncated).toBe(false);
    const over = applyRowCap(new Array(MAX_EXPORT_ROWS + 1).fill(0));
    expect(over.truncated).toBe(true);
    expect(over.rows).toHaveLength(MAX_EXPORT_ROWS);
  });
});

describe('escapeCsvCell — CSV-Formel-Injection', () => {
  it('prefixt Formel-Auslöser (=, +, -, @) mit Apostroph', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-2')).toBe("'-2");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('Zahlen werden NICHT geprefixt (deutsche Dezimal-Konvention)', () => {
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(1.5)).toBe('1,5');
  });

  it('quotet + verdoppelt Anführungszeichen bei Sonderzeichen', () => {
    expect(escapeCsvCell('a;b')).toBe('"a;b"');
    expect(escapeCsvCell('sag "hi"')).toBe('"sag ""hi"""');
  });

  it('null/undefined → leere Zelle', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('toCsv — Trunkierungs-Hinweiszeile', () => {
  const cols: CsvColumn<{ a: string }>[] = [{ key: 'a', label: 'A', accessor: (r) => r.a }];

  it('hängt sichtbare Hinweiszeile an, wenn truncatedNote gesetzt', () => {
    const csv = toCsv([{ a: 'x' }], cols, { truncatedNote: 'GEKÜRZT' });
    const lines = csv.split('\r\n');
    expect(lines[lines.length - 1]).toBe('GEKÜRZT');
  });

  it('ohne Note keine Zusatzzeile', () => {
    const csv = toCsv([{ a: 'x' }], cols);
    // Header + 1 Datenzeile, sonst nichts.
    expect(csv.split('\r\n')).toHaveLength(2);
  });
});
