// =============================================================================
// Tax-Calendar-Helpers
//
// Geteilt zwischen `/staff/calendar` und `/staff/tax-deadlines`. Vorher
// identisch in beiden Pages inline definiert.
// =============================================================================

import type { TaxScheduleKind } from '@prisma/client';
import { berlinDayEndUtc, berlinDayStartUtc, berlinYmd } from '@/lib/fmt';

/** Date.UTC interpretiert die Jahre 0 bis 99 als 1900 bis 1999. */
export function utcCalendarDay(year: number, month0: number, day = 1): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month0, day);
  return date;
}

export function calendarMonthKey(year: number, month0: number): string {
  return utcCalendarDay(year, month0).toISOString().split('T')[0]!.slice(0, -3);
}

export function isCalendarMonth(value: unknown): value is string {
  return typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * UTC-Instants des gewaehlten Europe/Berlin-Kalendermonats. Das Ende ist
 * exklusiv, damit ein Termin exakt um 00:00 Berlin des Folgemonats nicht mehr
 * in den Vormonat faellt. Die Laenge kann wegen der Zeitumstellung von der
 * reinen Anzahl Kalendertage mal 24 Stunden abweichen.
 */
export function berlinMonthBoundsUtc(
  year: number,
  month0: number,
): { start: Date; endExclusive: Date } {
  const start = berlinDayStartUtc(`${calendarMonthKey(year, month0)}-01`);
  let endExclusive = berlinDayStartUtc(`${calendarMonthKey(year, month0 + 1)}-01`);
  if (!endExclusive) {
    // Im Dezember 9999 liegt der Folgemonat außerhalb des Eingabeformats.
    const lastDay = utcCalendarDay(year, month0 + 1, 0)
      .toISOString()
      .split('T')[0]!;
    const lastInstant = berlinDayEndUtc(lastDay);
    if (lastInstant) endExclusive = new Date(lastInstant.getTime() + 1);
  }
  if (!start || !endExclusive) {
    throw new RangeError('Ungueltiger Kalendermonat.');
  }
  return { start, endExclusive };
}

/**
 * Parst einen `?month=YYYY-MM`-Query-Parameter. Bei fehlend/invalid: aktueller
 * Monat (Europe/Berlin). Rückgabe ist 0-basiert für JS-Date-Konsumenten.
 */
export function parseMonth(s: string | undefined): { year: number; month0: number } {
  if (isCalendarMonth(s)) {
    const [y, m] = s.split('-').map(Number);
    return { year: y!, month0: (m ?? 1) - 1 };
  }
  // Berlin-Monat, nicht UTC: am Monatsersten zwischen 00:00–02:00 Berlin würde
  // getUTCMonth() sonst den Vormonat aufschlagen.
  const [y, m] = berlinYmd(new Date()).split('-').map(Number);
  return { year: y!, month0: (m ?? 1) - 1 };
}

/**
 * Kompaktes Pill-Label für Steuertermin-Arten — bewusst kürzer als
 * `SCHEDULE_LABELS` für Kalender-Zellen, in denen Platz knapp ist.
 */
const SHORT_KIND_LABELS: Record<string, string> = {
  USTA_MONATLICH: 'USt-VA',
  USTA_QUARTAL: 'USt-VA',
  USTA_JAEHRLICH: 'USt-Jahr',
  LSTA_MONATLICH: 'LSt',
  LSTA_QUARTAL: 'LSt',
  LSTA_JAEHRLICH: 'LSt-Jahr',
  EST_VZ: 'ESt-VZ',
  KST_VZ: 'KSt-VZ',
  GEWST_VZ: 'GewSt-VZ',
  EST_ERKLAERUNG: 'ESt-Erkl.',
  KST_ERKLAERUNG: 'KSt-Erkl.',
  GEWST_ERKLAERUNG: 'GewSt-Erkl.',
};

export function shortKind(k: TaxScheduleKind | string): string {
  return SHORT_KIND_LABELS[k] ?? k;
}

// --- Monatsraster (P-20) ------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Eine Zelle des 6×7-Monatsrasters (Mo–So). `dayKey` ist der UTC-Kalendertag. */
export interface MonthGridCell {
  date: Date;
  dayKey: string;
  inMonth: boolean;
  isToday: boolean;
}

/**
 * 42 Zellen ab dem Montag der Woche, in der der Monatserste liegt. `todayKey`
 * ist der Berlin-Kalendertag (`berlinYmd`), damit „heute" in derselben
 * Zeitzone bestimmt wird wie die Zellen.
 */
export function buildMonthGridCells(
  year: number,
  month0: number,
  todayKey: string,
): MonthGridCell[] {
  const firstDayWeekday = (utcCalendarDay(year, month0).getUTCDay() + 6) % 7; // 0=Mo
  const gridStart = utcCalendarDay(year, month0, 1 - firstDayWeekday).getTime();
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart + index * DAY_MS);
    const dayKey = date.toISOString().split('T')[0]!;
    return { date, dayKey, inMonth: date.getUTCMonth() === month0, isToday: dayKey === todayKey };
  });
}

/** Zeile aus `taxDeadline.groupBy` über (Fälligkeit, Art, Periode, Status). */
export interface TaxDeadlineStatusCount {
  dueDate: Date;
  kind: string;
  period: string;
  status: string;
  _count: { _all: number };
}

/**
 * Eine Pille im Monatsraster: alle Termine einer Art und Periode an einem Tag.
 * Steuertermine sind für alle Mandanten gleich; die Pille zählt sie.
 */
export interface TaxDeadlineDayGroup {
  kind: string;
  period: string;
  total: number;
  /** PLANNED + REMINDED + IN_PROGRESS + OVERDUE + SUBMITTED */
  open: number;
  overdue: boolean;
}

/**
 * Fasst die DB-Zähler pro Tag (UTC-Kalendertag des @db.Date-Felds) und dann
 * pro Art + Periode zusammen. Die Reihenfolge der Pillen eines Tages folgt der
 * Reihenfolge der Eingabezeilen.
 */
export function groupTaxDeadlinesByDay(
  rows: Iterable<TaxDeadlineStatusCount>,
): Map<string, TaxDeadlineDayGroup[]> {
  const byDay = new Map<string, Map<string, TaxDeadlineDayGroup>>();
  for (const row of rows) {
    const dayKey = row.dueDate.toISOString().slice(0, 10);
    let day = byDay.get(dayKey);
    if (!day) {
      day = new Map();
      byDay.set(dayKey, day);
    }
    const groupKey = `${row.kind}::${row.period}`;
    let group = day.get(groupKey);
    if (!group) {
      group = { kind: row.kind, period: row.period, total: 0, open: 0, overdue: false };
      day.set(groupKey, group);
    }
    group.total += row._count._all;
    if (row.status !== 'DONE' && row.status !== 'SKIPPED') group.open += row._count._all;
    if (row.status === 'OVERDUE') group.overdue = true;
  }
  return new Map([...byDay].map(([dayKey, groups]) => [dayKey, [...groups.values()]]));
}

/** Link auf die Mandantenliste einer Termin-Gruppe (Art + Periode). */
export function taxDeadlineGroupHref(
  group: Pick<TaxDeadlineDayGroup, 'kind' | 'period'>,
  scope: 'mine' | 'all',
  q = '',
): string {
  return `/staff/tax-deadlines/group?kind=${group.kind}&period=${encodeURIComponent(group.period)}&scope=${scope}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
}
