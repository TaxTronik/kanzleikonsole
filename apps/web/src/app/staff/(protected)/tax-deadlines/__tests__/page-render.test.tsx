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

function sortBy<T extends Record<string, unknown>>(items: T[], orderBy: Order | undefined): T[] {
  const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      for (const order of keys) {
        const [key, dir] = Object.entries(order)[0]!;
        const left = a.item[key] as string | Date;
        const right = b.item[key] as string | Date;
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
  },
};

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['STAFF'] },
  })),
}));
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
