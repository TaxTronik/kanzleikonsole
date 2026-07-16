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
  fmtBytes,
  fmtIsoDate,
  berlinWallClockToUtc,
  berlinYmd,
  berlinTodayUtcMidnight,
} from '../fmt';

describe('fmtBytes', () => {
  it('formats byte sizes through gigabytes', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(2 * 1024 ** 2)).toBe('2.0 MB');
    expect(fmtBytes(2 * 1024 ** 3)).toBe('2.00 GB');
  });
});

describe('fmtIsoDate', () => {
  it('formats calendar dates without timezone conversion', () => {
    expect(fmtIsoDate('1976-08-31')).toBe('31.08.1976');
    expect(fmtIsoDate('1976-08-31T23:30:00-10:00')).toBe('31.08.1976');
    expect(fmtIsoDate(null)).toBeNull();
  });
});

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

describe('berlinWallClockToUtc', () => {
  it('Winter (CET, UTC+1): 14:30 Berlin → 13:30 UTC', () => {
    expect(berlinWallClockToUtc('2026-01-15T14:30')?.toISOString()).toBe(
      '2026-01-15T13:30:00.000Z',
    );
  });

  it('Sommer (CEST, UTC+2): 14:30 Berlin → 12:30 UTC', () => {
    expect(berlinWallClockToUtc('2026-07-15T14:30')?.toISOString()).toBe(
      '2026-07-15T12:30:00.000Z',
    );
  });

  it('optionale Sekunden werden übernommen', () => {
    expect(berlinWallClockToUtc('2026-07-15T14:30:45')?.toISOString()).toBe(
      '2026-07-15T12:30:45.000Z',
    );
  });

  it('Roundtrip: Berlin-Wanduhrzeit bleibt bei Berlin-Formatierung erhalten', () => {
    const utc = berlinWallClockToUtc('2026-07-15T14:30')!;
    expect(fmtTimeShort(utc)).toBe('14:30');
    const winter = berlinWallClockToUtc('2026-01-15T09:05')!;
    expect(fmtTimeShort(winter)).toBe('09:05');
  });

  it('ungültiges Format → null', () => {
    expect(berlinWallClockToUtc('kein-datum')).toBeNull();
    expect(berlinWallClockToUtc('2026-07-15')).toBeNull();
    expect(berlinWallClockToUtc('2026-07-15 14:30')).toBeNull();
    expect(berlinWallClockToUtc('')).toBeNull();
  });

  it('liefert für gültiges Format nie null (DST-Lückenstunde crasht nicht)', () => {
    // 29.03.2026 ist der Sommerzeit-Übergang; 02:30 existiert lokal nicht.
    // Erwartung: ein wohldefinierter Instant (kein Wurf, kein null).
    const d = berlinWallClockToUtc('2026-03-29T02:30');
    expect(d).not.toBeNull();
    expect(Number.isNaN(d!.getTime())).toBe(false);
  });
});

describe('berlinYmd', () => {
  it('vor Mitternacht Berlin (Winter): UTC-Tag ≠ Berlin-Tag', () => {
    // 23:30Z am 15.3. ist bereits 00:30 (16.3.) in Berlin (CET, +1).
    expect(berlinYmd(new Date('2026-03-15T23:30:00Z'))).toBe('2026-03-16');
  });

  it('vor Mitternacht Berlin (Sommer): 22:30Z → Folgetag', () => {
    // 22:30Z am 1.7. ist 00:30 (2.7.) in Berlin (CEST, +2).
    expect(berlinYmd(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02');
  });

  it('Mittag bleibt am selben Kalendertag', () => {
    expect(berlinYmd(new Date('2026-07-01T12:00:00Z'))).toBe('2026-07-01');
  });
});

describe('berlinTodayUtcMidnight', () => {
  it('gibt UTC-Mitternacht des Berlin-Kalendertags zurück', () => {
    // 01.07. 22:30Z = 02.07. 00:30 Berlin → heute = 2. Juli, 00:00 UTC.
    const m = berlinTodayUtcMidnight(new Date('2026-07-01T22:30:00Z'));
    expect(m.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });
});
