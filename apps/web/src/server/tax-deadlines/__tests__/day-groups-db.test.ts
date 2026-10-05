// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
// Review-Befund P-20: Die Monatsansicht von /staff/tax-deadlines zählt per
// groupBy statt alle Termine samt Mandant zu laden. Gegen echtes PostgreSQL über
// die App-Rolle (RLS) liefern beide Wege mit Sichtbarkeitsregel, „Meine
// Mandanten" und Suchfilter dieselben Pillen; nur die Request-Auth fehlt.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { Prisma, TaxDeadlineStatus, TaxScheduleKind } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import type { TaxDeadlineDayGroup } from '@/lib/tax-calendar';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));

import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { clientAccessFilter } from '@/server/auth/client-access-filter';
import { loadTaxDeadlineDayGroupsTx } from '../day-groups';

// Quality hat Platzhalter-URLs, aber keine Datenbank. Der db-Job schaltet den
// Test ausdrücklich ein; fehlende/ungültige URLs müssen dann scheitern.
const enabled = process.env.TAX_DEADLINE_DAY_GROUPS_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`TAX_DEADLINE_DAY_GROUPS_DB_TEST requires a valid ${name}.`);
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error(`TAX_DEADLINE_DAY_GROUPS_DB_TEST requires a PostgreSQL ${name}.`);
    }
  }
}

type Role = 'BERUFSTRAEGER' | 'HAUPTBEARBEITER' | 'FACHLICH';
const CLIENTS: ReadonlyArray<{ name: string; vertraulich: boolean; own?: Role }> = [
  { name: 'Alpha offen', vertraulich: false },
  { name: 'Beta offen zugeordnet', vertraulich: false, own: 'HAUPTBEARBEITER' },
  { name: 'Gamma vertraulich', vertraulich: true },
  { name: 'Delta vertraulich zugeordnet', vertraulich: true, own: 'BERUFSTRAEGER' },
  { name: 'Epsilon offen fachlich', vertraulich: false, own: 'FACHLICH' },
];
// (Art, Periode, Fälligkeit) — mehrere Gruppen je Tag, Ränder und Nachbarmonate.
const TEMPLATES: ReadonlyArray<[TaxScheduleKind, string, string]> = [
  ['USTA_MONATLICH', '2026-01', '2026-02-10'],
  ['USTA_MONATLICH', '2026-02', '2026-03-10'],
  ['USTA_QUARTAL', '2025-Q4', '2026-03-10'],
  ['LSTA_MONATLICH', '2026-02', '2026-03-10'],
  ['EST_VZ', '2026-Q1', '2026-03-10'],
  ['KST_VZ', '2026-Q1', '2026-03-10'],
  ['GEWST_VZ', '2026-Q1', '2026-03-01'],
  ['USTA_JAEHRLICH', '2025', '2026-03-16'],
  ['EST_ERKLAERUNG', '2025', '2026-03-31'],
  ['USTA_MONATLICH', '2026-03', '2026-04-01'],
];
const STATUSES: TaxDeadlineStatus[] = [
  'PLANNED',
  'REMINDED',
  'IN_PROGRESS',
  'SUBMITTED',
  'DONE',
  'OVERDUE',
  'SKIPPED',
];
const KIND_ORDER: TaxScheduleKind[] = [
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
const MARCH_START = new Date(Date.UTC(2026, 2, 1));
const MARCH_END = new Date(Date.UTC(2026, 3, 0, 23, 59, 59, 999));

function statusFor(clientIndex: number, templateIndex: number): TaxDeadlineStatus {
  return STATUSES[(clientIndex * 3 + templateIndex * 5) % STATUSES.length]!;
}

// Wortgleiche Zählung der früheren `renderMonth`-Schleife über findMany-Zeilen.
function legacyByDay(
  rows: ReadonlyArray<{ dueDate: Date; kind: string; period: string; status: string }>,
) {
  const byDay = new Map<string, Map<string, TaxDeadlineDayGroup>>();
  for (const d of rows) {
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
    if (d.status !== 'DONE' && d.status !== 'SKIPPED') g.open += 1;
    if (d.status === 'OVERDUE') g.overdue = true;
  }
  return byDay;
}

function canonical(byDay: Map<string, Iterable<TaxDeadlineDayGroup>>) {
  return [...byDay]
    .map(([day, groups]) => ({
      day,
      groups: [...groups].sort((a, b) =>
        `${a.kind}|${a.period}`.localeCompare(`${b.kind}|${b.period}`),
      ),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

(enabled ? describe : describe.skip)('P-20 Monatszähler per groupBy = frühere Zählung', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId: string, foreignTenantId: string, employeeId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (await owner.tenant.create({ data: { slug: `p20-${suffix}`, name: 'P-20 Monat' } }))
      .id;
    foreignTenantId = (
      await owner.tenant.create({ data: { slug: `p20-foreign-${suffix}`, name: 'P-20 fremd' } })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'access', value: { clientAccessMode: 'OPEN' } },
    });
    employeeId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `p20-${suffix}@example.test`,
          fullName: 'P-20 Mitarbeiter',
          passwordHash: 'x',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      })
    ).id;
    const create = async (tenant: string, spec: (typeof CLIENTS)[number], index: number) => {
      const client = await owner.client.create({
        data: { tenantId: tenant, kind: 'NATPERS', name: spec.name, vertraulich: spec.vertraulich },
      });
      if (spec.own && tenant === tenantId) {
        await owner.clientResponsibility.create({
          data: { tenantId, clientId: client.id, staffId: employeeId, role: spec.own },
        });
      }
      await owner.taxDeadline.createMany({
        data: TEMPLATES.map(([kind, period, due], templateIndex) => ({
          tenantId: tenant,
          clientId: client.id,
          kind,
          period,
          dueDate: new Date(`${due}T00:00:00.000Z`),
          status: statusFor(index, templateIndex),
        })),
      });
    };
    for (const [index, spec] of CLIENTS.entries()) await create(tenantId, spec, index);
    // Fremder Tenant mit identischen Terminen: darf nie mitgezählt werden (RLS).
    for (const [index, spec] of CLIENTS.entries()) await create(foreignTenantId, spec, index);
  });

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
      if (foreignTenantId) await owner.tenant.delete({ where: { id: foreignTenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  function asEmployee<T>(run: (tx: TxClient, session: StaffSession) => Promise<T>): Promise<T> {
    const session = {
      user: { tenantId, staffId: employeeId, roles: ['EMPLOYEE'], permissions: [] },
    } as never as StaffSession;
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${employeeId}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
      return run(tx as TxClient, session);
    });
  }

  function expectedFor(visible: (spec: Spec) => boolean) {
    const rows = CLIENTS.flatMap((spec, index) =>
      visible(spec)
        ? TEMPLATES.map(([kind, period, due], templateIndex) => ({
            dueDate: new Date(`${due}T00:00:00.000Z`),
            kind,
            period,
            status: statusFor(index, templateIndex),
          }))
        : [],
    ).filter((row) => row.dueDate >= MARCH_START && row.dueDate <= MARCH_END);
    return canonical(new Map([...legacyByDay(rows)].map(([day, map]) => [day, map.values()])));
  }

  const readable = (spec: Spec) =>
    !spec.vertraulich || spec.own === 'BERUFSTRAEGER' || spec.own === 'HAUPTBEARBEITER';

  type Spec = (typeof CLIENTS)[number];
  // Seitenfilter wie in /staff/tax-deadlines (scope=mine bindet an den Mitarbeiter).
  it.each<[string, (staffId: string) => Prisma.ClientWhereInput, (spec: Spec) => boolean]>([
    ['alle Mandanten', () => ({}), readable],
    [
      'meine Mandanten',
      (staffId) => ({ responsibilities: { some: { staffId } } }),
      (spec) => readable(spec) && spec.own !== undefined,
    ],
    [
      'Suche „offen"',
      () => ({ OR: [{ name: { contains: 'OFFEN', mode: 'insensitive' } }] }),
      (spec) => readable(spec) && spec.name.includes('offen'),
    ],
  ])('%s: dieselben Pillen wie die Zählung über findMany', async (_label, pageFilter, visible) => {
    const { legacy, grouped } = await asEmployee(async (tx, session) => {
      const clientWhere = pageFilter(employeeId);
      const where: Prisma.TaxDeadlineWhereInput = {
        ...clientAccessFilter(await accessibleClientsWhereFor(tx, session), clientWhere),
        dueDate: { gte: MARCH_START, lte: MARCH_END },
      };
      const rows = await tx.taxDeadline.findMany({
        where,
        orderBy: { dueDate: 'asc' },
        include: { client: { select: { id: true, name: true } } },
      });
      return { legacy: legacyByDay(rows), grouped: await loadTaxDeadlineDayGroupsTx(tx, where) };
    });

    const expected = expectedFor(visible);
    expect(expected.length).toBeGreaterThan(0);
    expect(canonical(new Map([...legacy].map(([day, map]) => [day, map.values()])))).toEqual(
      expected,
    );
    expect(canonical(grouped)).toEqual(expected);
    // Stabile Pillen-Reihenfolge je Tag: Enum-Reihenfolge der Art, dann Periode.
    for (const groups of grouped.values()) {
      const order = groups.map((g) => [KIND_ORDER.indexOf(g.kind as TaxScheduleKind), g.period]);
      expect(order).toEqual(
        [...order].sort((a, b) =>
          a[0] !== b[0] ? Number(a[0]) - Number(b[0]) : String(a[1]).localeCompare(String(b[1])),
        ),
      );
    }
  });
});
