import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { berlinMonthBoundsUtc } from '@/lib/tax-calendar';

const source = readFileSync(resolve(__dirname, '../page.tsx'), 'utf8');
const deadlineQuery = source.slice(
  source.indexOf('tx.taxDeadline.'),
  source.indexOf('tx.appointment.findMany'),
);
const appointmentQuery = source.slice(
  source.indexOf('tx.appointment.findMany'),
  source.indexOf('tx.appointmentRequest.findMany'),
);

describe('Kalender-Steuertermine', () => {
  it('aggregiert die Monatsdaten in der Datenbank und lädt keine Client-Relation', () => {
    expect(deadlineQuery).toContain('tx.taxDeadline.groupBy({');
    expect(deadlineQuery).toContain("by: ['dueDate', 'kind', 'period', 'status']");
    expect(deadlineQuery).toContain('_count: { _all: true }');
    expect(deadlineQuery).not.toContain('findMany');
    expect(deadlineQuery).not.toContain('include');
  });

  it('übernimmt die DB-Zähler in Gesamt- und Offen-Anzahl', () => {
    expect(source).toContain('g.total += d._count._all');
    expect(source).toContain('if (isOpen) g.open += d._count._all');
  });

  it('lässt @db.Date-Steuertermine auf separaten UTC-Kalendertag-Grenzen', () => {
    expect(deadlineQuery).toContain('dueDate: { gte: dateStart, lte: dateEnd }');
    expect(deadlineQuery).not.toContain('appointmentStart');
    expect(deadlineQuery).not.toContain('appointmentEndExclusive');
  });
});

describe('Kalender-Termine: Europe/Berlin-Monatsgrenzen', () => {
  it.each([
    [2026, 0, '2025-12-31T23:00:00.000Z', '2026-01-31T23:00:00.000Z'],
    [2026, 6, '2026-06-30T22:00:00.000Z', '2026-07-31T22:00:00.000Z'],
  ])(
    'bildet den Monat %i/%i im Winter bzw. Sommer DST-korrekt ab',
    (year, month0, expectedStart, expectedEnd) => {
      const bounds = berlinMonthBoundsUtc(year, month0);
      expect(bounds.start.toISOString()).toBe(expectedStart);
      expect(bounds.endExclusive.toISOString()).toBe(expectedEnd);
    },
  );

  it('bildet Monate mit DST-Wechsel mit 23- bzw. 25-Stunden-Tag ab', () => {
    const march = berlinMonthBoundsUtc(2026, 2);
    const october = berlinMonthBoundsUtc(2026, 9);

    expect(march.endExclusive.getTime() - march.start.getTime()).toBe(743 * 60 * 60 * 1000);
    expect(october.endExclusive.getTime() - october.start.getTime()).toBe(745 * 60 * 60 * 1000);
  });

  it('nimmt den frühen ersten Berlin-Tag auf und schließt den Folgemonat aus', () => {
    const { start, endExclusive } = berlinMonthBoundsUtc(2026, 6);
    const isInJuly = (instant: string) => {
      const value = new Date(instant);
      return value >= start && value < endExclusive;
    };

    // 01.07. 00:30 Berlin (CEST)
    expect(isInJuly('2026-06-30T22:30:00.000Z')).toBe(true);
    // 01.08. 01:30 Berlin (CEST)
    expect(isInJuly('2026-07-31T23:30:00.000Z')).toBe(false);
  });

  it('wendet die halb-offenen Berlin-Grenzen auf die Appointment-Query an', () => {
    expect(appointmentQuery).toContain('startsAt: { lt: appointmentEndExclusive }');
    expect(appointmentQuery).toContain('endsAt: { gte: appointmentStart }');
    expect(appointmentQuery).not.toContain('dateStart');
    expect(appointmentQuery).not.toContain('dateEnd');
  });
});
