// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Review-Befund F-14: Kennzahlen der Steuertermin-Liste per count() mit exakt
// dem Filter der jeweiligen (seitenweise begrenzten) Liste.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  OVERDUE_PAGE_SIZE,
  UPCOMING_PAGE_SIZE,
  UPCOMING_STATUSES,
  clampListPage,
  loadDeadlineListTx,
  parseListPage,
} from '../_list-data';

const tx = {
  taxDeadline: { count: vi.fn(), findMany: vi.fn() },
};
const visible = {
  client: { AND: [{ OR: [{ vertraulich: false }] }, { name: { contains: 'x' } }] },
};

function countWhere(index: number) {
  return tx.taxDeadline.count.mock.calls[index]![0].where;
}
function findManyArgs(index: number) {
  return tx.taxDeadline.findMany.mock.calls[index]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.taxDeadline.findMany.mockResolvedValue([]);
});

describe('loadDeadlineListTx', () => {
  it('zählt Überfällige und Anstehende mit genau dem Filter ihrer Liste', async () => {
    tx.taxDeadline.count
      .mockResolvedValueOnce(312)
      .mockResolvedValueOnce(845)
      .mockResolvedValueOnce(17);

    const result = await loadDeadlineListTx(tx as unknown as TxClient, visible, {
      overdue: 1,
      upcoming: 1,
    });

    expect(countWhere(0)).toEqual({ ...visible, status: 'OVERDUE' });
    expect(countWhere(1)).toEqual({ ...visible, status: { in: [...UPCOMING_STATUSES] } });
    expect(countWhere(2)).toEqual({ ...visible, status: 'DONE', completedAt: { not: null } });
    expect(findManyArgs(0).where).toEqual(countWhere(0));
    expect(findManyArgs(1).where).toEqual(countWhere(1));
    expect(result).toMatchObject({
      overdueCount: 312,
      upcomingCount: 845,
      doneCount: 17,
      pages: { overdue: 1, upcoming: 1 },
    });
  });

  it('bleibt bei den bisherigen Kappungen als Seitengröße und sortiert stabil', async () => {
    tx.taxDeadline.count.mockResolvedValue(1000);

    await loadDeadlineListTx(tx as unknown as TxClient, visible, { overdue: 3, upcoming: 2 });

    expect(findManyArgs(0)).toMatchObject({
      skip: 2 * OVERDUE_PAGE_SIZE,
      take: OVERDUE_PAGE_SIZE,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      include: { client: { select: { id: true, name: true } } },
    });
    expect(findManyArgs(1)).toMatchObject({
      skip: UPCOMING_PAGE_SIZE,
      take: UPCOMING_PAGE_SIZE,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
    expect(OVERDUE_PAGE_SIZE).toBe(100);
    expect(UPCOMING_PAGE_SIZE).toBe(200);
  });

  it('klemmt Seiten jenseits des Endes an die letzte vorhandene Seite', async () => {
    tx.taxDeadline.count
      .mockResolvedValueOnce(101)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const result = await loadDeadlineListTx(tx as unknown as TxClient, visible, {
      overdue: 99,
      upcoming: 7,
    });

    expect(result.pages).toEqual({ overdue: 2, upcoming: 1 });
    expect(findManyArgs(0).skip).toBe(OVERDUE_PAGE_SIZE);
    expect(findManyArgs(1).skip).toBe(0);
  });
});

describe('parseListPage / clampListPage', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['0', 1],
    ['-2', 1],
    ['1.5', 1],
    ['abc', 1],
    [['4', '5'], 4],
    ['12', 12],
  ])('normalisiert %j zu %i', (value, expected) => {
    expect(parseListPage(value)).toBe(expected);
  });

  it('liefert mindestens Seite 1, auch ohne Treffer', () => {
    expect(clampListPage(5, 0, 100)).toBe(1);
    expect(clampListPage(2, 100, 100)).toBe(1);
    expect(clampListPage(2, 101, 100)).toBe(2);
  });
});
