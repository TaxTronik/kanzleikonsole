// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001, TAX-DEADLINE-WORKDAY-001.
// Real PostgreSQL transactions and materialization engine. Synchronization
// barriers stop at an actual config read; pg_blocking_pids proves who waits.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tenantId: string, clientId: string, staffId: string, configId: string;
let lockSchedule: (tx: TxClient, tenantId: string) => Promise<void>;
type RunAtomic = <T>(fn: (tx: TxClient) => Promise<T>) => Promise<T>;
let materialize: (
  deps: {
    db: TxClient;
    runAtomic: RunAtomic;
    recordEvidence: () => Promise<void>;
    upsertStaffNotification: () => Promise<void>;
    resolveStaffNotifications: () => Promise<void>;
  },
  params: { tenantId: string; systemStaffId: string; now: Date; horizonDays: number },
) => Promise<{ deadlinesCreated: number }>;

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const transaction: RunAtomic = (fn) =>
  app.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
      return fn(tx);
    },
    { timeout: 15_000 },
  );
async function backendId(tx: TxClient) {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`;
  return row!.pid;
}
async function waitsFor(pid: number, blocker: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await owner.$queryRaw<
      Array<{ blockers: number[] }>
    >`SELECT pg_blocking_pids(${pid}::integer) AS blockers`;
    if (row?.blockers.includes(blocker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
function run(runAtomic: RunAtomic = transaction) {
  return materialize(
    {
      db: owner,
      runAtomic,
      recordEvidence: async () => {},
      upsertStaffNotification: async () => {},
      resolveStaffNotifications: async () => {},
    },
    { tenantId, systemStaffId: staffId, now: new Date('2026-06-09T10:00:00Z'), horizonDays: 50 },
  );
}
async function edit(tx: TxClient, active: boolean) {
  // Same gate and write order as saveScheduleConfigAction; autoRequest is off,
  // so these synthetic candidates have no request/evidence rows to remove.
  await lockSchedule(tx, tenantId);
  await tx.taxDeadline.deleteMany({ where: { tenantId, clientId, configId } });
  await tx.taxScheduleConfig.update({
    where: { id: configId },
    data: { active, hasDauerfrist: true },
  });
}
async function mayDeadline() {
  return owner.taxDeadline.findFirst({ where: { tenantId, configId, period: '2026-05' } });
}

beforeAll(async () => {
  // No circular package dependency solely for this database regression.
  const enginePath = new URL('../../../tax/src/materialize.ts', import.meta.url).href;
  const engine = await import(enginePath);
  materialize = engine.materializeTenantTaxDeadlines;
  lockSchedule = engine.lockTaxScheduleTx;
  const suffix = randomUUID();
  tenantId = (
    await owner.tenant.create({
      data: { slug: `schedule-consistency-${suffix}`, name: 'Synthetic schedule consistency' },
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
  clientId = (
    await owner.client.create({ data: { tenantId, name: 'Synthetic client', kind: 'JURPERS' } })
  ).id;
  await createVerifiedLegalEntityGwgFixture(owner, { tenantId, clientId, verifiedBy: staffId });
  await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
  configId = (
    await owner.taxScheduleConfig.create({
      data: {
        tenantId,
        clientId,
        kind: 'USTA_MONATLICH',
        active: true,
        hasDauerfrist: false,
        autoRequest: false,
        createdByStaff: staffId,
      },
    })
  ).id;
});
beforeEach(async () => {
  await owner.taxDeadline.deleteMany({ where: { tenantId } });
  await owner.tenantSetting.deleteMany({ where: { tenantId, key: 'tax_region' } });
  await owner.taxScheduleConfig.update({
    where: { id: configId },
    data: { active: true, hasDauerfrist: false, kind: 'USTA_MONATLICH' },
  });
});
afterAll(async () => {
  try {
    if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  } finally {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
});

describe('schedule edits and materialization share one transaction gate', () => {
  it.each([true, false])(
    'reads the committed changed configuration after an edit wins (active=%s)',
    async (active) => {
      const editing = barrier<number>();
      const release = barrier();
      const producing = barrier<number>();
      const mutation = transaction(async (tx) => {
        await edit(tx, active);
        editing.resolve(await backendId(tx));
        await release.promise;
      });
      const editPid = await Promise.race([editing.promise, mutation.then(() => -1)]);
      const production = run((fn) =>
        transaction(async (tx) => {
          producing.resolve(await backendId(tx));
          return fn(tx);
        }),
      );
      try {
        expect(await waitsFor(await producing.promise, editPid)).toBe(true);
      } finally {
        release.resolve();
        await Promise.all([mutation, production]);
      }
      await run(); // repeat remains idempotent and cannot preserve the old date
      if (active)
        expect((await mayDeadline())?.dueDate.toISOString()).toBe('2026-07-10T00:00:00.000Z');
      else expect(await owner.taxDeadline.count({ where: { tenantId } })).toBe(0);
    },
  );

  it('lets a running producer commit before the edit removes its old candidates', async () => {
    const read = barrier<number>();
    const release = barrier();
    const editing = barrier<number>();
    const production = run((fn) =>
      transaction(async (tx) => {
        const pid = await backendId(tx);
        const paused = new Proxy(tx, {
          get(target, key) {
            if (key === 'taxScheduleConfig')
              return {
                findMany: async (
                  args: Parameters<TxClient['taxScheduleConfig']['findMany']>[0],
                ) => {
                  const rows = await tx.taxScheduleConfig.findMany(args);
                  read.resolve(pid);
                  await release.promise;
                  return rows;
                },
              };
            return Reflect.get(target, key);
          },
        });
        return fn(paused);
      }),
    );
    const producerPid = await Promise.race([read.promise, production.then(() => -1)]);
    const mutation = transaction(async (tx) => {
      editing.resolve(await backendId(tx));
      await edit(tx, true);
    });
    try {
      expect(await waitsFor(await editing.promise, producerPid)).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([production, mutation]);
    }
    await run();
    expect((await mayDeadline())?.dueDate.toISOString()).toBe('2026-07-10T00:00:00.000Z');
    expect(await owner.taxDeadline.count({ where: { tenantId, period: '2026-05' } })).toBe(1);
  });

  it('keeps concurrent producers idempotent', async () => {
    const outcomes = await Promise.all([run(), run()]);
    const rows = await owner.taxDeadline.findMany({ where: { tenantId } });
    expect(outcomes.reduce((sum, value) => sum + value.deadlinesCreated, 0)).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.period)).size).toBe(rows.length);
  });

  it('serializes the real region writer and preserves the documented existing-date policy', async () => {
    const writerPath = new URL(
      '../../../../apps/web/src/server/settings/tax-region.ts',
      import.meta.url,
    ).href;
    const { writeTaxRegionTx } = await import(writerPath);
    await owner.taxScheduleConfig.update({ where: { id: configId }, data: { kind: 'GEWST_VZ' } });
    const runAugust = (runAtomic: RunAtomic = transaction) =>
      materialize(
        {
          db: owner,
          runAtomic,
          recordEvidence: async () => {},
          upsertStaffNotification: async () => {},
          resolveStaffNotifications: async () => {},
        },
        {
          tenantId,
          systemStaffId: staffId,
          now: new Date('2028-08-01T10:00:00Z'),
          horizonDays: 20,
        },
      );
    const holding = barrier<number>(),
      release = barrier(),
      writing = barrier<number>();
    // Start with a candidate-generation transaction. The region writer must
    // wait until this snapshot has inserted its August 15 candidate.
    const production = runAugust((fn) =>
      transaction(async (tx) => {
        await lockSchedule(tx, tenantId);
        holding.resolve(await backendId(tx));
        await release.promise;
        return fn(tx);
      }),
    );
    const producerPid = await Promise.race([holding.promise, production.then(() => -1)]);
    const mutation = transaction(async (tx) => {
      writing.resolve(await backendId(tx));
      await writeTaxRegionTx(tx, { tenantId, actorType: 'STAFF', actorId: staffId }, 'DE-BY', true);
    });
    try {
      expect(await waitsFor(await writing.promise, producerPid)).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([production, mutation]);
    }
    await runAugust();
    const existing = await owner.taxDeadline.findFirstOrThrow({
      where: { tenantId, period: '2028-Q3' },
    });
    expect(existing.dueDate.toISOString()).toBe('2028-08-15T00:00:00.000Z');
    // A newly created synthetic candidate uses the now committed region.
    await owner.taxDeadline.deleteMany({ where: { tenantId } });
    await runAugust();
    const fresh = await owner.taxDeadline.findFirstOrThrow({
      where: { tenantId, period: '2028-Q3' },
    });
    expect(fresh.dueDate.toISOString()).toBe('2028-08-16T00:00:00.000Z');
  });
});
