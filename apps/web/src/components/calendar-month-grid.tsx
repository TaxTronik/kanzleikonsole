// =============================================================================
// Monatsraster für /staff/calendar und /staff/tax-deadlines (Review-Befund P-20).
//
// Vorher waren Raster, Zellen und Steuertermin-Pillen zwischen beiden Seiten
// kopiert. Die Seiten liefern nur noch, was sich unterscheidet: Zellenhöhe,
// „heute"-Markierung, Pillen-Limit, Erledigt-Stil und den Zelleninhalt.
// =============================================================================

import type { ReactNode } from 'react';
import Link from 'next/link';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { fmtWeekdayShort } from '@/lib/fmt';
import {
  shortKind,
  taxDeadlineGroupHref,
  type MonthGridCell,
  type TaxDeadlineDayGroup,
} from '@/lib/tax-calendar';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export function CalendarMonthGrid({
  cells,
  cellClassName,
  todayClassName,
  renderDay,
}: {
  cells: readonly MonthGridCell[];
  /** Vollständige Klassen der Zelle im Monat bzw. außerhalb (Tailwind-Literale). */
  cellClassName: { inMonth: string; outside: string };
  todayClassName: string;
  renderDay: (cell: MonthGridCell) => ReactNode;
}) {
  return (
    <div className="card p-2">
      <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted uppercase tracking-wide pb-2 border-b border-default">
        {WEEKDAYS.map((i) => (
          <div key={i} className="py-2">
            {fmtWeekdayShort(new Date(Date.UTC(2026, 0, 5 + i)))}
          </div>
        ))}
      </div>
      <div
        className="grid grid-cols-7 gap-px mt-px"
        style={{ backgroundColor: 'rgb(var(--border-default))' }}
      >
        {cells.map((cell, i) => (
          <div key={i} className={cell.inMonth ? cellClassName.inMonth : cellClassName.outside}>
            <div className={cell.isToday ? todayClassName : 'self-start text-secondary'}>
              {cell.date.getUTCDate()}
            </div>
            {renderDay(cell)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pillen der Steuertermin-Gruppen eines Tages, höchstens `limit` Stück. */
export function TaxDeadlinePills({
  groups,
  limit,
  doneClassName,
  scope,
  q,
}: {
  groups: readonly TaxDeadlineDayGroup[];
  limit: number;
  /** Klasse einer Gruppe ohne offene Termine. */
  doneClassName: string;
  scope: 'mine' | 'all';
  q?: string;
}) {
  return (
    <>
      {groups.slice(0, limit).map((g) => (
        <Link
          key={`${g.kind}-${g.period}`}
          href={taxDeadlineGroupHref(g, scope, q)}
          className={
            g.overdue
              ? 'cal-pill cal-pill-overdue'
              : g.open === 0
                ? doneClassName
                : 'cal-pill cal-pill-pending'
          }
          title={`${SCHEDULE_LABELS[g.kind as keyof typeof SCHEDULE_LABELS]} ${g.period} — ${g.open}/${g.total} offen`}
        >
          <span className="font-medium">{shortKind(g.kind)}</span>
          <span className="opacity-70">
            {' '}
            · {g.open}/{g.total}
          </span>
        </Link>
      ))}
    </>
  );
}

/** „+N weitere" für Einträge, die über die Pillen-Limits einer Zelle hinausgehen. */
export function MoreEntries({ count }: { count: number }) {
  if (count <= 0) return null;
  return <div className="text-[10px] text-muted">+{count} weitere</div>;
}
