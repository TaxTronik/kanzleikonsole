import { describe, it, expect } from 'vitest';
import { addCalendarMonths, dsgvoResponseDeadline } from '../deadline';

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m, day, 9, 30, 0));
const ymd = (x: Date) =>
  `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;

describe('addCalendarMonths — monatsende-sicher (§ 188 Abs. 3 BGB)', () => {
  it('31.01. + 1 Monat → 28.02. (kein Überlauf auf 03.03.)', () => {
    expect(ymd(addCalendarMonths(d(2026, 0, 31), 1))).toBe('2026-02-28');
  });

  it('31.01. + 1 Monat im Schaltjahr → 29.02.', () => {
    expect(ymd(addCalendarMonths(d(2024, 0, 31), 1))).toBe('2024-02-29');
  });

  it('15.01. + 1 Monat → 15.02. (Regelfall unverändert)', () => {
    expect(ymd(addCalendarMonths(d(2026, 0, 15), 1))).toBe('2026-02-15');
  });

  it('31.08. + 1 Monat → 30.09.', () => {
    expect(ymd(addCalendarMonths(d(2026, 7, 31), 1))).toBe('2026-09-30');
  });

  it('31.12. + 1 Monat → 31.01. des Folgejahres', () => {
    expect(ymd(addCalendarMonths(d(2025, 11, 31), 1))).toBe('2026-01-31');
  });

  it('erhält die Uhrzeit des Ausgangsdatums', () => {
    const out = addCalendarMonths(d(2026, 0, 31), 1);
    expect(out.getUTCHours()).toBe(9);
    expect(out.getUTCMinutes()).toBe(30);
  });
});

describe('dsgvoResponseDeadline', () => {
  it('entspricht +1 Kalendermonat', () => {
    expect(ymd(dsgvoResponseDeadline(d(2026, 0, 31)))).toBe('2026-02-28');
  });
});
