import { describe, it, expect } from 'vitest';
import {
  round2,
  fmtEUR,
  fmtNumber,
  fmtPercent,
  fmtDateShort,
  fmtTimeShort,
  fmtDateTimeShort,
  fmtMonthYear,
  fmtMinutes,
} from '../fmt';

const SAMPLE = new Date(Date.UTC(2026, 4, 12, 14, 35, 21)); // 12. Mai 2026, 14:35:21 UTC

describe('fmt', () => {
  it('round2 rundet kaufmännisch (half away from zero), float-robust', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.236)).toBe(1.24);
    expect(round2(0)).toBe(0);
    expect(round2(99.999)).toBe(100);
    // Exakte Halbcent-Grenzen kippen jetzt korrekt nach oben (vorher abgerundet).
    expect(round2(1.005)).toBe(1.01);
    expect(round2(8.575)).toBe(8.58);
    expect(round2(10.075)).toBe(10.08);
    // Knapp darunter bleibt unten; Negative runden vom Nullpunkt weg.
    expect(round2(1.004)).toBe(1.0);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(-2.5 / 100)).toBe(-0.03);
  });

  it('fmtEUR formats positive, negative and nullish', () => {
    expect(fmtEUR(1234.5)).toMatch(/1\.234,50.*€/);
    expect(fmtEUR(0)).toMatch(/0,00.*€/);
    expect(fmtEUR(-50)).toMatch(/-50,00.*€/);
    expect(fmtEUR(null)).toBe('—');
    expect(fmtEUR(undefined)).toBe('—');
  });

  it('fmtNumber uses German thousand/decimal separators', () => {
    expect(fmtNumber(1234567.89)).toBe('1.234.567,89');
    expect(fmtNumber(null)).toBe('—');
  });

  it('fmtPercent converts decimal fraction', () => {
    expect(fmtPercent(0.5)).toMatch(/50.*%/);
    expect(fmtPercent(0.123)).toMatch(/12,3.*%/);
    expect(fmtPercent(null)).toBe('—');
  });

  it('fmtDateShort uses dd.MM.yyyy', () => {
    expect(fmtDateShort(SAMPLE)).toMatch(/12\.5\.2026|12\.05\.2026/);
  });

  it('fmtTimeShort uses HH:mm', () => {
    // Will reflect runtime timezone — just check shape
    expect(fmtTimeShort(SAMPLE)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('fmtDateTimeShort combines date + time', () => {
    expect(fmtDateTimeShort(SAMPLE)).toMatch(/\d{2}\.\d{2}\.\d{2,4},\s*\d{2}:\d{2}/);
  });

  it('fmtMonthYear gives German long month + year', () => {
    expect(fmtMonthYear(SAMPLE)).toBe('Mai 2026');
  });

  it('fmtMinutes splits into hours and minutes', () => {
    expect(fmtMinutes(0)).toBe('0m');
    expect(fmtMinutes(45)).toBe('45m');
    expect(fmtMinutes(60)).toBe('1h 0m');
    expect(fmtMinutes(135)).toBe('2h 15m');
  });
});
