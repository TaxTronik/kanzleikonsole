// =============================================================================
// Listenansicht der Steuertermine: Kennzahlen und seitenweise Listen.
//
// Review-Befund F-14: Die Kacheln „Überfällig“ und „Anstehend“ zeigten die
// Länge der auf 100 bzw. 200 Zeilen gekappten Listen. Jetzt zählt `count()`
// mit exakt demselben Filter wie die jeweilige Liste; die Listen selbst bleiben
// begrenzt (Seitengröße = bisherige Kappung) und sind seitenweise erreichbar.
// =============================================================================

import type { Prisma, TaxDeadlineStatus } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

export const OVERDUE_PAGE_SIZE = 100;
export const UPCOMING_PAGE_SIZE = 200;

export const UPCOMING_STATUSES: readonly TaxDeadlineStatus[] = [
  'PLANNED',
  'REMINDED',
  'IN_PROGRESS',
  'SUBMITTED',
];

// Viele Termine teilen sich ein Fälligkeitsdatum (gleiche Frist für alle
// Mandanten). Die ID als zweiter Schlüssel hält die Seiten stabil: ohne sie
// dürfte PostgreSQL gleichrangige Zeilen je Seite anders anordnen.
const LIST_ORDER: Prisma.TaxDeadlineOrderByWithRelationInput[] = [
  { dueDate: 'asc' },
  { id: 'asc' },
];

/** `?overduePage=` / `?upcomingPage=`: positive Ganzzahl, sonst Seite 1. */
export function parseListPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/** Klemmt eine angefragte Seite an die letzte vorhandene (mindestens 1). */
export function clampListPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page), last);
}

export interface DeadlineListPages {
  overdue: number;
  upcoming: number;
}

/**
 * Lädt Kennzahlen und die angefragten Seiten beider Listen in der übergebenen
 * Tenant-Transaktion. `visible` ist der bereits aus Sichtbarkeitsregel und
 * Seitenfiltern gebildete `client`-Filter; jede Liste und ihr Zähler verwenden
 * ihn unverändert.
 */
export async function loadDeadlineListTx(
  tx: TxClient,
  visible: Prisma.TaxDeadlineWhereInput,
  requested: DeadlineListPages,
) {
  const overdueWhere: Prisma.TaxDeadlineWhereInput = { ...visible, status: 'OVERDUE' };
  const upcomingWhere: Prisma.TaxDeadlineWhereInput = {
    ...visible,
    status: { in: [...UPCOMING_STATUSES] },
  };
  const [overdueCount, upcomingCount, doneCount] = await Promise.all([
    tx.taxDeadline.count({ where: overdueWhere }),
    tx.taxDeadline.count({ where: upcomingWhere }),
    tx.taxDeadline.count({
      where: { ...visible, status: 'DONE', completedAt: { not: null } },
    }),
  ]);
  const pages: DeadlineListPages = {
    overdue: clampListPage(requested.overdue, overdueCount, OVERDUE_PAGE_SIZE),
    upcoming: clampListPage(requested.upcoming, upcomingCount, UPCOMING_PAGE_SIZE),
  };
  const include = { client: { select: { id: true, name: true } } } as const;
  const [overdue, upcoming] = await Promise.all([
    tx.taxDeadline.findMany({
      where: overdueWhere,
      orderBy: LIST_ORDER,
      include,
      skip: (pages.overdue - 1) * OVERDUE_PAGE_SIZE,
      take: OVERDUE_PAGE_SIZE,
    }),
    tx.taxDeadline.findMany({
      where: upcomingWhere,
      orderBy: LIST_ORDER,
      include,
      skip: (pages.upcoming - 1) * UPCOMING_PAGE_SIZE,
      take: UPCOMING_PAGE_SIZE,
    }),
  ]);
  return { overdue, overdueCount, upcoming, upcomingCount, doneCount, pages };
}
