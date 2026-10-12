import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { berlinMonthBoundsUtc, groupTaxDeadlinesByDay } from '@/lib/tax-calendar';
import { loadTaxDeadlineDayGroupsTx } from '@/server/tax-deadlines/day-groups';

// Die Abfragen der Kalenderseite (Tageslader, Berlin-Grenzen der Termine,
// Absagen) prüft page-render.test.tsx am gerenderten Kalender (B-08).
describe('Kalender-Steuertermine', () => {
  it('aggregiert die Monatsdaten in der Datenbank und lädt keine Client-Relation', async () => {
    // P-20: Kanzleikalender und /staff/tax-deadlines teilen diesen Lader.
    const groupBy = vi.fn(async () => [
      {
        dueDate: new Date(Date.UTC(2026, 2, 10)),
        kind: 'USTA_MONATLICH',
        period: '2026-02',
        status: 'PLANNED',
        _count: { _all: 3 },
      },
    ]);
    const findMany = vi.fn();
    const tx = { taxDeadline: { groupBy, findMany } } as unknown as TxClient;
    const where = { dueDate: { gte: new Date(Date.UTC(2026, 2, 1)) } };

    const groups = await loadTaxDeadlineDayGroupsTx(tx, where);

    expect(groupBy).toHaveBeenCalledOnce();
    expect(groupBy).toHaveBeenCalledWith({
      by: ['dueDate', 'kind', 'period', 'status'],
      where,
      orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { period: 'asc' }],
      _count: { _all: true },
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(groups.get('2026-03-10')).toEqual([
      { kind: 'USTA_MONATLICH', period: '2026-02', total: 3, open: 3, overdue: false },
    ]);
  });

  it('übernimmt die DB-Zähler in Gesamt- und Offen-Anzahl', () => {
    const dueDate = new Date(Date.UTC(2026, 2, 10));
    const groups = groupTaxDeadlinesByDay([
      {
        dueDate,
        kind: 'USTA_MONATLICH',
        period: '2026-02',
        status: 'PLANNED',
        _count: { _all: 7 },
      },
      { dueDate, kind: 'USTA_MONATLICH', period: '2026-02', status: 'DONE', _count: { _all: 5 } },
    ]);
    expect(groups.get('2026-03-10')).toEqual([
      { kind: 'USTA_MONATLICH', period: '2026-02', total: 12, open: 7, overdue: false },
    ]);
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
});
