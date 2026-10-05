// Review-Befund P-20: Monatsraster und Steuertermin-Gruppierung sind zwischen
// /staff/tax-deadlines und /staff/calendar geteilt. Die Tests vergleichen die
// neue Gruppierung der DB-Zähler (groupBy) mit der früheren Zählung über einzelne
// Terminzeilen und das Raster mit der früheren Rasterberechnung beider Seiten.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  buildMonthGridCells,
  groupTaxDeadlinesByDay,
  taxDeadlineGroupHref,
  type TaxDeadlineDayGroup,
  type TaxDeadlineStatusCount,
} from '../tax-calendar';

const KINDS = ['USTA_MONATLICH', 'LSTA_QUARTAL', 'EST_VZ', 'GEWST_ERKLAERUNG'] as const;
const STATUSES = [
  'PLANNED',
  'REMINDED',
  'IN_PROGRESS',
  'SUBMITTED',
  'DONE',
  'OVERDUE',
  'SKIPPED',
] as const;

interface DeadlineRow {
  dueDate: Date;
  kind: string;
  period: string;
  status: string;
}

// Wortgleiche Zählung der früheren `renderMonth`-Schleife (eine Zeile je Termin).
function legacyByDay(deadlines: readonly DeadlineRow[]) {
  const byDay = new Map<string, Map<string, TaxDeadlineDayGroup>>();
  for (const d of deadlines) {
    const dayKey = d.dueDate.toISOString().slice(0, 10);
    const groupKey = `${d.kind}::${d.period}`;
    let dayMap = byDay.get(dayKey);
    if (!dayMap) {
      dayMap = new Map();
      byDay.set(dayKey, dayMap);
    }
    let g = dayMap.get(groupKey);
    if (!g) {
      g = { kind: d.kind, period: d.period, total: 0, open: 0, overdue: false };
      dayMap.set(groupKey, g);
    }
    g.total += 1;
    const isOpen = d.status !== 'DONE' && d.status !== 'SKIPPED';
    if (isOpen) g.open += 1;
    if (d.status === 'OVERDUE') g.overdue = true;
  }
  return byDay;
}

// Was `groupBy({ by: ['dueDate','kind','period','status'], _count: { _all: true } })`
// aus denselben Zeilen liefert (Reihenfolge beliebig).
function aggregate(deadlines: readonly DeadlineRow[]): TaxDeadlineStatusCount[] {
  const rows = new Map<string, TaxDeadlineStatusCount>();
  for (const d of deadlines) {
    const key = [d.dueDate.toISOString(), d.kind, d.period, d.status].join('|');
    const row = rows.get(key) ?? { ...d, _count: { _all: 0 } };
    row._count._all += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

function canonical(byDay: Map<string, Iterable<TaxDeadlineDayGroup>>) {
  return [...byDay]
    .map(([day, groups]) => [
      day,
      [...groups].sort((a, b) => `${a.kind}${a.period}`.localeCompare(`${b.kind}${b.period}`)),
    ])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
}

const deadlineArb: fc.Arbitrary<DeadlineRow> = fc.record({
  dueDate: fc.integer({ min: 1, max: 31 }).map((day) => new Date(Date.UTC(2026, 2, day))),
  kind: fc.constantFrom(...KINDS),
  period: fc.constantFrom('2025', '2026-01', '2026-02', '2026-Q1'),
  status: fc.constantFrom(...STATUSES),
});

describe('groupTaxDeadlinesByDay', () => {
  it('liefert aus den DB-Zählern dieselben Pillen wie die frühere Zählung je Termin', () => {
    fc.assert(
      fc.property(fc.array(deadlineArb, { maxLength: 400 }), fc.boolean(), (deadlines, reverse) => {
        const rows = aggregate(deadlines);
        if (reverse) rows.reverse();
        expect(canonical(groupTaxDeadlinesByDay(rows))).toEqual(
          canonical(new Map([...legacyByDay(deadlines)].map(([k, v]) => [k, v.values()]))),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('zählt Erledigt/Übersprungen nicht als offen und markiert Überfällige', () => {
    const day = new Date(Date.UTC(2026, 2, 10));
    const row = (status: string, n: number): TaxDeadlineStatusCount => ({
      dueDate: day,
      kind: 'USTA_MONATLICH',
      period: '2026-02',
      status,
      _count: { _all: n },
    });
    const groups = groupTaxDeadlinesByDay([
      row('PLANNED', 3),
      row('DONE', 4),
      row('SKIPPED', 1),
      row('OVERDUE', 2),
      row('SUBMITTED', 5),
    ]);
    expect(groups.get('2026-03-10')).toEqual([
      { kind: 'USTA_MONATLICH', period: '2026-02', total: 15, open: 10, overdue: true },
    ]);
  });

  it('übernimmt die Reihenfolge der (sortierten) DB-Zeilen für die Pillen eines Tages', () => {
    const day = new Date(Date.UTC(2026, 2, 10));
    const groups = groupTaxDeadlinesByDay(
      ['USTA_MONATLICH', 'LSTA_MONATLICH', 'EST_VZ'].map((kind) => ({
        dueDate: day,
        kind,
        period: '2026-Q1',
        status: 'PLANNED',
        _count: { _all: 1 },
      })),
    );
    expect(groups.get('2026-03-10')?.map((g) => g.kind)).toEqual([
      'USTA_MONATLICH',
      'LSTA_MONATLICH',
      'EST_VZ',
    ]);
  });
});

// Frühere Rasterberechnung (in beiden Seiten identisch kopiert).
function legacyCells(year: number, month0: number, todayKey: string) {
  const firstDayWeekday = (new Date(Date.UTC(year, month0, 1)).getUTCDay() + 6) % 7;
  const gridStart = new Date(Date.UTC(year, month0, 1 - firstDayWeekday));
  const cells: Array<{ date: Date; inMonth: boolean; isToday: boolean; k: string }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getTime() + i * 24 * 60 * 60 * 1000);
    const cellKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    cells.push({
      date: d,
      inMonth: d.getUTCMonth() === month0,
      isToday: cellKey === todayKey,
      k: d.toISOString().slice(0, 10),
    });
  }
  return cells;
}

describe('buildMonthGridCells', () => {
  it('entspricht für jeden Monat 2020–2032 der früheren Rasterberechnung', () => {
    for (let year = 2020; year <= 2032; year++) {
      for (let month0 = 0; month0 < 12; month0++) {
        const todayKey = `${year}-${String(month0 + 1).padStart(2, '0')}-15`;
        const cells = buildMonthGridCells(year, month0, todayKey);
        expect(
          cells.map((c) => ({ date: c.date, inMonth: c.inMonth, isToday: c.isToday, k: c.dayKey })),
        ).toEqual(legacyCells(year, month0, todayKey));
      }
    }
  });

  it('beginnt am Montag und markiert genau einen heutigen Tag', () => {
    const cells = buildMonthGridCells(2026, 2, '2026-03-10');
    expect(cells).toHaveLength(42);
    expect(cells[0]!.dayKey).toBe('2026-02-23');
    expect(cells[0]!.date.getUTCDay()).toBe(1);
    expect(cells.filter((c) => c.isToday).map((c) => c.dayKey)).toEqual(['2026-03-10']);
    expect(cells.filter((c) => c.inMonth)).toHaveLength(31);
  });
});

describe('taxDeadlineGroupHref', () => {
  it('erzeugt dieselben Links wie zuvor in beiden Monatsansichten', () => {
    const group = { kind: 'USTA_QUARTAL', period: '2026 Q1/2' };
    expect(taxDeadlineGroupHref(group, 'all')).toBe(
      `/staff/tax-deadlines/group?kind=${group.kind}&period=${encodeURIComponent(group.period)}&scope=all`,
    );
    expect(taxDeadlineGroupHref(group, 'mine', 'Mü & Co')).toBe(
      `/staff/tax-deadlines/group?kind=USTA_QUARTAL&period=2026%20Q1%2F2&scope=mine&q=${encodeURIComponent('Mü & Co')}`,
    );
  });
});
