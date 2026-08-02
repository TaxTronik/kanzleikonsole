import { describe, expect, it } from 'vitest';
import { formatXlsxCell, formatXlsxDate } from '../format-cell';

describe('formatXlsxDate', () => {
  it('zeigt reine Datumszellen ohne Uhrzeit', () => {
    expect(formatXlsxDate(new Date('2025-12-31T00:00:00.000Z'))).toBe('31.12.25');
  });

  it('behaelt die Uhrzeit bei Zeitstempeln', () => {
    expect(formatXlsxDate(new Date('2025-03-14T09:30:00.000Z'))).toBe('14.03.25, 09:30');
  });

  it('formatiert in UTC, nicht in lokaler Zone', () => {
    // Excel-Daten sind Wanduhrzeit. In Europe/Berlin formatiert waere der
    // 31.12.2025 00:00 sonst "31.12.25, 01:00" — ein sichtbarer Tagesversatz
    // bei Sommerzeit-naher Mitternacht.
    expect(formatXlsxDate(new Date('2025-06-30T23:30:00.000Z'))).toBe('30.06.25, 23:30');
  });
});

describe('formatXlsxCell', () => {
  it('bildet die uebrigen Zelltypen ab', () => {
    expect(formatXlsxCell(null)).toBe('');
    expect(formatXlsxCell('Text')).toBe('Text');
    expect(formatXlsxCell(-2500.5)).toBe('-2.500,5');
    expect(formatXlsxCell(180000)).toBe('180.000');
    expect(formatXlsxCell(true)).toBe('Ja');
    expect(formatXlsxCell(false)).toBe('Nein');
  });
});
