// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Rendert /staff/tax-deadlines mit Fixtures gegen eine nachgebildete Tenant-Tx.

import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  clientId: string;
  kind: string;
  period: string;
  dueDate: Date;
  status: string;
  requestId: string | null;
  completedAt: Date | null;
};
type Where = {
  client?: unknown;
  dueDate?: { gte?: Date; lte?: Date };
  status?: string | { in: string[] };
  completedAt?: { not: null };
};
type Order = Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  calls: [] as Array<{ op: string; where: unknown }>,
}));

function matches(row: Row, where: Where): boolean {
  if (where.dueDate?.gte && row.dueDate < where.dueDate.gte) return false;
  if (where.dueDate?.lte && row.dueDate > where.dueDate.lte) return false;
  if (typeof where.status === 'string' && row.status !== where.status) return false;
  if (typeof where.status === 'object' && !where.status.in.includes(row.status)) return false;
  if (where.completedAt && row.completedAt === null) return false;
  return true;
}

// PostgreSQL sortiert Enums nach Deklarationsreihenfolge, nicht alphabetisch.
const KIND_ORDER = [
  'USTA_MONATLICH',
  'USTA_QUARTAL',
  'USTA_JAEHRLICH',
  'LSTA_MONATLICH',
  'LSTA_QUARTAL',
  'LSTA_JAEHRLICH',
  'EST_VZ',
  'KST_VZ',
  'GEWST_VZ',
  'EST_ERKLAERUNG',
  'KST_ERKLAERUNG',
  'GEWST_ERKLAERUNG',
];

function sortBy<T extends Record<string, unknown>>(items: T[], orderBy: Order | undefined): T[] {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  const rank = (key: string, value: unknown) =>
    (key === 'kind' ? KIND_ORDER.indexOf(String(value)) : value) as string | number | Date;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      for (const order of keys) {
        const [key, dir] = Object.entries(order)[0]!;
        const left = rank(key, a.item[key]);
        const right = rank(key, b.item[key]);
        const cmp = left < right ? -1 : left > right ? 1 : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

const tx = {
  taxDeadline: {
    count: vi.fn(async ({ where }: { where: Where }) => {
      h.calls.push({ op: 'count', where });
      return h.rows.filter((row) => matches(row, where)).length;
    }),
    findMany: vi.fn(
      async (args: { where: Where; orderBy?: Order; skip?: number; take?: number }) => {
        h.calls.push({ op: 'findMany', where: args.where });
        const skip = args.skip ?? 0;
        return sortBy(
          h.rows.filter((row) => matches(row, args.where)),
          args.orderBy,
        )
          .slice(skip, args.take === undefined ? undefined : skip + args.take)
          .map((row) => ({
            ...row,
            client: { id: row.clientId, name: `Mandant ${row.clientId}` },
          }));
      },
    ),
    groupBy: vi.fn(async (args: { by: Array<keyof Row>; where: Where; orderBy?: Order }) => {
      h.calls.push({ op: 'groupBy', where: args.where });
      const groups = new Map<string, Record<string, unknown> & { _count: { _all: number } }>();
      for (const row of h.rows.filter((candidate) => matches(candidate, args.where))) {
        const key = args.by.map((field) => String(row[field])).join('|');
        const group = groups.get(key) ?? {
          ...Object.fromEntries(args.by.map((field) => [field, row[field]])),
          _count: { _all: 0 },
        };
        group._count._all += 1;
        groups.set(key, group);
      }
      return sortBy([...groups.values()], args.orderBy);
    }),
  },
};

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
// Modul-Gate der Seite (requireModulePage) ist separat getestet; hier aktiv.
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: vi.fn(async () => ({ OR: [{ vertraulich: false }] })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (t: typeof tx) => unknown) => fn(tx)),
}));
vi.mock('@/components/saved-views', () => ({ SavedViews: () => null }));
vi.mock('@/components/action-form', () => ({
  ActionForm: ({ children }: { children: ReactNode }) => <form>{children}</form>,
}));
vi.mock('../actions', () => ({
  rematerializeAction: async () => ({ ok: true }),
  markDeadlineDoneAction: async () => ({ ok: true }),
}));

import TaxDeadlinesPage from '../page';

function day(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function addRows(count: number, status: (index: number) => string, year: number) {
  for (let index = 0; index < count; index += 1) {
    const n = h.rows.length + 1;
    h.rows.push({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      clientId: `client-${(n % 9) + 1}`,
      kind: 'USTA_MONATLICH',
      period: `${year}-${index}`,
      dueDate: day(`${year}-${String(1 + (index % 12)).padStart(2, '0')}-10`),
      status: status(index),
      requestId: null,
      completedAt: status(index) === 'DONE' ? day(`${year}-01-11`) : null,
    });
  }
}

async function render(searchParams: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(
    await TaxDeadlinesPage({ searchParams: Promise.resolve(searchParams) as never }),
  );
}

function tile(html: string, label: string): string | undefined {
  const match = new RegExp(`>${label}</p><p class="[^"]*">([^<]+)</p>`).exec(html);
  return match?.[1];
}

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-03-10T09:00:00.000Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0;
  h.calls.length = 0;
});

describe('Steuertermine — Listenansicht (F-14)', () => {
  it('zeigt die gezählten Gesamtzahlen statt der gekappten Listenlängen', async () => {
    addRows(1_312, () => 'OVERDUE', 2025);
    addRows(245, (i) => ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'SUBMITTED'][i % 4]!, 2027);
    addRows(4, () => 'DONE', 2024);

    const html = await render({ view: 'list' });

    expect(tile(html, 'Überfällig')).toBe('1.312');
    expect(tile(html, 'Anstehend')).toBe('245');
    expect(tile(html, 'Erledigt \\(gesamt\\)')).toBe('4');
    expect(html).toContain('100 von 1.312 angezeigt');
    expect(html).toContain('200 von 245 angezeigt');
    expect(html.match(/<tr class="hover:bg-gray-50">/g)).toHaveLength(300);
    // Jeder Zähler nutzt den Filter seiner Liste (inklusive Sichtbarkeitsregel).
    const counts = h.calls.filter((call) => call.op === 'count').map((call) => call.where);
    const lists = h.calls.filter((call) => call.op === 'findMany').map((call) => call.where);
    expect(lists).toEqual([counts[0], counts[1]]);
    expect(counts[0]).toMatchObject({ client: { OR: [{ vertraulich: false }] } });
  });

  it('blättert jede Liste getrennt und behält dabei die Seite der anderen Liste', async () => {
    addRows(250, () => 'OVERDUE', 2025);
    addRows(450, () => 'PLANNED', 2027);

    const html = await render({ view: 'list', scope: 'mine', q: 'Müller', overduePage: '3' });

    expect(html).toContain('50 von 250 angezeigt');
    expect(html).toContain('201–250 von 250');
    expect(html).toContain('Seite 3 von 3');
    expect(html).toContain(
      'href="/staff/tax-deadlines?view=list&amp;scope=mine&amp;q=M%C3%BCller&amp;overduePage=2"',
    );
    // Die anstehende Liste blättert weiter und nimmt overduePage=3 mit.
    expect(html).toContain(
      'href="/staff/tax-deadlines?view=list&amp;scope=mine&amp;q=M%C3%BCller&amp;overduePage=3&amp;upcomingPage=2"',
    );
  });

  it('zeigt ohne Kappung weder Hinweis noch Seitennavigation', async () => {
    addRows(3, () => 'OVERDUE', 2025);
    addRows(5, () => 'PLANNED', 2027);

    const html = await render({ view: 'list' });

    expect(tile(html, 'Überfällig')).toBe('3');
    expect(tile(html, 'Anstehend')).toBe('5');
    expect(html).not.toContain('angezeigt');
    expect(html).not.toContain('Seitennavigation');
  });
});

describe('Steuertermine — Monatsansicht (P-20)', () => {
  function addDay(dueDate: string, kind: string, period: string, statuses: string[]) {
    for (const status of statuses) {
      const n = h.rows.length + 1;
      h.rows.push({
        id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        clientId: `client-${n}`,
        kind,
        period,
        dueDate: day(dueDate),
        status,
        requestId: null,
        completedAt: null,
      });
    }
  }

  it('zählt per groupBy mit Sichtbarkeits- und Seitenfilter statt Terminzeilen zu laden', async () => {
    addDay('2026-03-10', 'USTA_MONATLICH', '2026-02', ['PLANNED', 'DONE']);
    addDay('2026-04-10', 'USTA_MONATLICH', '2026-03', ['PLANNED']);

    await render({ month: '2026-03', scope: 'mine', q: 'Müller' });

    expect(tx.taxDeadline.findMany).not.toHaveBeenCalled();
    expect(tx.taxDeadline.groupBy).toHaveBeenCalledTimes(1);
    expect(tx.taxDeadline.groupBy.mock.calls[0]![0]).toEqual({
      by: ['dueDate', 'kind', 'period', 'status'],
      where: {
        client: {
          AND: [
            { OR: [{ vertraulich: false }] },
            {
              responsibilities: { some: { staffId: 'staff-1' } },
              OR: [
                { name: { contains: 'Müller', mode: 'insensitive' } },
                { datevNo: { contains: 'Müller', mode: 'insensitive' } },
                { addisonNo: { contains: 'Müller', mode: 'insensitive' } },
              ],
            },
          ],
        },
        dueDate: { gte: day('2026-03-01'), lte: new Date('2026-03-31T23:59:59.999Z') },
      },
      orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }, { period: 'asc' }],
      _count: { _all: true },
    });
  });

  it('zeigt je Tag höchstens vier Pillen mit Zählern, Zustand und Gruppenlink', async () => {
    addDay('2026-03-10', 'GEWST_VZ', '2026-Q1', ['REMINDED']);
    addDay('2026-03-10', 'USTA_MONATLICH', '2026-02', ['PLANNED', 'DONE', 'OVERDUE']);
    addDay('2026-03-10', 'LSTA_MONATLICH', '2026-02', ['DONE', 'SKIPPED']);
    addDay('2026-03-10', 'EST_VZ', '2026-Q1', ['SUBMITTED', 'PLANNED']);
    addDay('2026-03-10', 'KST_VZ', '2026-Q1', ['IN_PROGRESS']);

    const html = await render({ month: '2026-03', scope: 'mine', q: 'Müller' });

    const pills = [...html.matchAll(/<a class="(cal-pill[^"]*)" title="([^"]*)" href="([^"]*)"/g)];
    expect(pills.map(([, cls, title]) => [cls, title])).toEqual([
      ['cal-pill cal-pill-overdue', 'USt-Voranmeldung (monatlich) 2026-02 — 2/3 offen'],
      ['cal-pill cal-pill-appointment', 'Lohnsteuer-Anmeldung (monatlich) 2026-02 — 0/2 offen'],
      ['cal-pill cal-pill-pending', 'ESt-Vorauszahlung 2026-Q1 — 2/2 offen'],
      ['cal-pill cal-pill-pending', 'KSt-Vorauszahlung 2026-Q1 — 1/1 offen'],
    ]);
    expect(pills[0]![3]).toBe(
      '/staff/tax-deadlines/group?kind=USTA_MONATLICH&amp;period=2026-02&amp;scope=mine&amp;q=M%C3%BCller',
    );
    expect(html).toContain('<div class="text-[10px] text-muted">+1 weitere</div>');
    expect(html).toContain(
      '<div class="self-start font-bold text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded">10</div>',
    );
  });
});
