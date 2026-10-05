// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001, TAX-DEADLINE-WORKDAY-001
// P-14: Speichern des Zeitplans EINES Mandanten materialisiert in der
// Web-Transaktion (App-Rolle, RLS) nur dessen Termine: dieselben Zeilen wie ein
// tenantweiter Lauf, andere Mandanten bleiben unberührt, Anforderungen legt
// erst der Worker-Lauf an.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Client-Scope-Materialisierung braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

type RunAtomic = <T>(fn: (tx: TxClient) => Promise<T>) => Promise<T>;
type Materialize = (
  deps: {
    db: TxClient;
    runAtomic: RunAtomic;
    recordEvidence: () => Promise<void>;
    upsertStaffNotification: () => Promise<void>;
    resolveStaffNotifications: () => Promise<void>;
  },
  params: {
    tenantId: string;
    clientId?: string;
    systemStaffId: string;
    now: Date;
    horizonDays: number;
  },
) => Promise<{ deadlinesCreated: number; requestsCreated: number; markedOverdue: number }>;

const NOW = new Date('2026-06-09T10:00:00Z');
let materialize: Materialize;
let tenantId = '';
let staffId = '';
let clientA = '';
let clientB = '';

/** Wie der Web-Pfad: eine App-Rollen-Transaktion mit Tenant-Kontext. */
function inStaffTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
      return fn(tx);
    },
    { timeout: 15_000 },
  );
}

function run(clientId?: string) {
  return inStaffTransaction((tx) =>
    materialize(
      {
        db: tx,
        runAtomic: (fn) => fn(tx),
        recordEvidence: async () => {},
        upsertStaffNotification: async () => {},
        resolveStaffNotifications: async () => {},
      },
      { tenantId, clientId, systemStaffId: staffId, now: NOW, horizonDays: 60 },
    ),
  );
}

async function deadlineRows(clientId: string) {
  const rows = await owner.taxDeadline.findMany({
    where: { tenantId, clientId },
    select: { configId: true, kind: true, period: true, dueDate: true },
    orderBy: [{ kind: 'asc' }, { period: 'asc' }],
  });
  return rows.map((row) => ({ ...row, dueDate: row.dueDate.toISOString() }));
}

async function createClient(name: string) {
  const id = (await owner.client.create({ data: { tenantId, name, kind: 'JURPERS' } })).id;
  await createVerifiedLegalEntityGwgFixture(owner, { tenantId, clientId: id, verifiedBy: staffId });
  await owner.client.update({ where: { id }, data: { allowActive: true } });
  return id;
}

async function createConfig(
  clientId: string,
  kind: 'USTA_MONATLICH' | 'USTA_QUARTAL' | 'EST_VZ',
  autoRequest: boolean,
) {
  await owner.taxScheduleConfig.create({
    data: {
      tenantId,
      clientId,
      kind,
      active: true,
      hasDauerfrist: false,
      autoRequest,
      // Fälligkeit 10.06. liegt im Versandfenster; ohne Vorwarnung legt ein
      // tenantweiter Lauf die Anforderung sofort an.
      reminderDaysBefore: 14,
      staffLeadDays: 0,
      createdByStaff: staffId,
    },
  });
}

describeWithDatabase('Steuertermin-Materialisierung je Mandant (P-14)', () => {
  beforeAll(async () => {
    const enginePath = new URL('../../../tax/src/materialize.ts', import.meta.url).href;
    materialize = (await import(enginePath)).materializeTenantTaxDeadlines;
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({
        data: { slug: `schedule-client-scope-${suffix}`, name: 'Synthetic client scope' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${suffix}@example.test`,
          fullName: 'Synthetic administrator',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    clientA = await createClient('Mandant A');
    clientB = await createClient('Mandant B');
    await createConfig(clientA, 'USTA_MONATLICH', true);
    await createConfig(clientA, 'EST_VZ', false);
    await createConfig(clientB, 'USTA_QUARTAL', false);
  });

  // Termine mit Benachrichtigungshistorie dürfen erst nach einer terminalen
  // Anforderung gelöscht werden (TAX-DEADLINE-AUTOREQUEST-001).
  async function resetDeadlines() {
    await owner.request.updateMany({ where: { tenantId }, data: { status: 'CANCELLED' } });
    await owner.taxDeadline.deleteMany({ where: { tenantId } });
    await owner.request.deleteMany({ where: { tenantId } });
  }

  beforeEach(resetDeadlines);

  afterAll(async () => {
    try {
      // Tenant-Purge: die Delete-Trigger lassen die Kaskade ohne Historie zu.
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it('legt für den Mandanten dieselben Termine an wie der tenantweite Lauf', async () => {
    const scoped = await run(clientA);
    const scopedRows = await deadlineRows(clientA);

    expect(scoped.deadlinesCreated).toBe(scopedRows.length);
    expect(scopedRows.length).toBeGreaterThan(0);
    expect(await owner.taxDeadline.count({ where: { tenantId, clientId: clientB } })).toBe(0);

    await resetDeadlines();
    await run();

    expect(await deadlineRows(clientA)).toEqual(scopedRows);
    expect(
      await owner.taxDeadline.count({ where: { tenantId, clientId: clientB } }),
    ).toBeGreaterThan(0);
  });

  it('überlässt Vorwarnung und Anforderung dem Worker-Lauf', async () => {
    const scoped = await run(clientA);

    expect(scoped.requestsCreated).toBe(0);
    expect(await owner.request.count({ where: { tenantId } })).toBe(0);
    expect(await owner.taxDeadline.count({ where: { tenantId, status: { not: 'PLANNED' } } })).toBe(
      0,
    );

    // Der tenantweite Lauf (Worker) legt die fällige Anforderung danach an.
    const full = await run();
    expect(full.requestsCreated).toBe(1);
    expect(await owner.request.count({ where: { tenantId, clientId: clientA } })).toBe(1);
  });

  it('markiert nur abgelaufene Termine des Mandanten als OVERDUE', async () => {
    const pastConfig = await owner.taxScheduleConfig.findFirstOrThrow({
      where: { tenantId, clientId: clientB },
      select: { id: true },
    });
    const pastA = await owner.taxScheduleConfig.findFirstOrThrow({
      where: { tenantId, clientId: clientA, kind: 'EST_VZ' },
      select: { id: true },
    });
    await owner.taxDeadline.createMany({
      data: [
        {
          tenantId,
          clientId: clientA,
          configId: pastA.id,
          kind: 'EST_VZ',
          period: '2026-Q1',
          dueDate: new Date('2026-03-10T00:00:00Z'),
        },
        {
          tenantId,
          clientId: clientB,
          configId: pastConfig.id,
          kind: 'USTA_QUARTAL',
          period: '2026-Q1',
          dueDate: new Date('2026-04-10T00:00:00Z'),
        },
      ],
    });

    const scoped = await run(clientA);

    expect(scoped.markedOverdue).toBe(1);
    const statuses = await owner.taxDeadline.findMany({
      where: { tenantId, period: '2026-Q1' },
      select: { clientId: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((row) => [row.clientId, row.status]))).toEqual({
      [clientA]: 'OVERDUE',
      [clientB]: 'PLANNED',
    });
  });
});
