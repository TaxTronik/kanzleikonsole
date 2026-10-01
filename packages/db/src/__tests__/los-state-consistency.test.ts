// TCMS-SAMPLE-PROOF-001: real app-role concurrency and complete rollback.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tenantId: string;
let staffId: string;
let clientId: string;
let state: {
  reserveLosStartTx(tx: TxClient, tenantId: string, start: object, actorId: string): Promise<void>;
  claimLosPendingTx(tx: TxClient, tenantId: string, pending: object): Promise<void>;
  claimLosStartTx(
    tx: TxClient,
    tenantId: string,
    attemptId: string,
    expectedStart?: object,
  ): Promise<void>;
};
let evidence: { record(tx: TxClient, event: object): Promise<unknown> };
const pending = { jobId: 'job-a', commitment: 'frame-a', k: 2, rahmen: ['a', 'b'] };
const start = { attemptId: randomUUID(), rahmen: ['a', 'b'], k: 2 };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function transaction<T>(fn: (tx: TxClient) => Promise<T>) {
  return app.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8s'");
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
      set_config('app.current_actor_type', 'STAFF', true), set_config('app.current_actor_id', ${staffId}, true)`;
      return fn(tx);
    },
    { timeout: 12_000 },
  );
}
async function pid(tx: TxClient) {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  return rows[0]!.pid;
}
async function waitsFor(waiter: number, blocker: number) {
  for (let i = 0; i < 200; i++) {
    const rows = await owner.$queryRaw<
      Array<{ blockers: number[] }>
    >`SELECT pg_blocking_pids(${waiter}::int) AS blockers`;
    if (rows[0]?.blockers.includes(blocker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
const read = (key: string) =>
  owner.tenantSetting.findUnique({ where: { tenantId_key: { tenantId, key } } });
const putPending = (value: object = pending) =>
  owner.tenantSetting.create({ data: { tenantId, key: 'quantenlos.pending', value } });
const reminder = (tx: TxClient) =>
  tx.clientReminder.create({
    data: {
      tenantId,
      clientId,
      subject: 'Los proof',
      dueDate: new Date(),
      createdByStaff: staffId,
      assignees: { create: [{ staffId }] },
    },
  });

beforeAll(async () => {
  const statePath = new URL('../../../../apps/web/src/server/risk/los-state.ts', import.meta.url)
    .href;
  state = await import(statePath);
  const evidencePath = new URL('../../../evidence/src/service.ts', import.meta.url).href;
  const { EvidenceService } = await import(evidencePath);
  evidence = new EvidenceService({});
  tenantId = (
    await owner.tenant.create({ data: { slug: `los-cas-${randomUUID()}`, name: 'Los CAS' } })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `los-${randomUUID()}@test.local`,
        fullName: 'Los test',
        passwordHash: 'x',
      },
    })
  ).id;
  await owner.staffRole.create({ data: { staffUserId: staffId, role: 'ADMIN' } });
  clientId = (
    await owner.client.create({ data: { tenantId, name: 'Los test client', kind: 'NATPERS' } })
  ).id;
});
beforeEach(async () => {
  await owner.tenantSetting.deleteMany({ where: { tenantId } });
  await owner.clientReminder.deleteMany({ where: { tenantId } });
});
afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe('TCMS-SAMPLE-PROOF-001 real database CAS', () => {
  it('serializes two start reservations, preserving the first before either remote call', async () => {
    const held = deferred<number>();
    const release = deferred<void>();
    const first = transaction(async (tx) => {
      await state.reserveLosStartTx(tx, tenantId, start, staffId);
      held.resolve(await pid(tx));
      await release.promise;
    });
    const blocker = await held.promise;
    const entered = deferred<number>();
    const second = transaction(async (tx) => {
      entered.resolve(await pid(tx));
      await state.reserveLosStartTx(tx, tenantId, { ...start, attemptId: randomUUID() }, staffId);
    }).then(
      () => null,
      (error: unknown) => error,
    );
    let blocked: boolean;
    try {
      blocked = await waitsFor(await entered.promise, blocker);
    } finally {
      release.resolve();
    }
    await first;
    expect(String(await second)).toMatch(/anderer Auftrag/);
    expect(blocked).toBe(true);
    expect((await read('quantenlos.start'))?.value).toEqual(start);
  });

  it('allows only one pending consumer and one task, even with two real connections', async () => {
    await putPending();
    const held = deferred<number>();
    const release = deferred<void>();
    const first = transaction(async (tx) => {
      await state.claimLosPendingTx(tx, tenantId, pending);
      await reminder(tx);
      held.resolve(await pid(tx));
      await release.promise;
    });
    const blocker = await held.promise;
    const entered = deferred<number>();
    const second = transaction(async (tx) => {
      entered.resolve(await pid(tx));
      await state.claimLosPendingTx(tx, tenantId, pending);
      await reminder(tx);
    }).then(
      () => null,
      (error: unknown) => error,
    );
    let blocked: boolean;
    try {
      blocked = await waitsFor(await entered.promise, blocker);
    } finally {
      release.resolve();
    }
    await first;
    expect(String(await second)).toMatch(/bereits bearbeitet/);
    expect(blocked).toBe(true);
    expect(await read('quantenlos.pending')).toBeNull();
    expect(await owner.clientReminder.count({ where: { tenantId } })).toBe(1);
  });

  it('preserves a newer pending job and rejects a changed frame even for the same job id', async () => {
    const newer = { ...pending, jobId: 'job-b' };
    await putPending(newer);
    await expect(
      transaction((tx) => state.claimLosPendingTx(tx, tenantId, pending)),
    ).rejects.toThrow(/bereits bearbeitet/);
    expect((await read('quantenlos.pending'))?.value).toEqual(newer);
    await expect(
      transaction((tx) =>
        state.claimLosPendingTx(tx, tenantId, { ...newer, rahmen: ['different'] }),
      ),
    ).rejects.toThrow(/bereits bearbeitet/);
    await expect(
      transaction((tx) => state.reserveLosStartTx(tx, tenantId, start, staffId)),
    ).rejects.toThrow(/anderer Auftrag/);
    expect((await read('quantenlos.pending'))?.value).toEqual(newer);
  });

  it('a failure after actual EvidenceService.record rolls back claim, task and audit together', async () => {
    await putPending();
    await expect(
      transaction(async (tx) => {
        await state.claimLosPendingTx(tx, tenantId, pending);
        await reminder(tx);
        await evidence.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'risk.los.gezogen',
          resourceType: 'quantenlos',
          resourceId: 'frame-a',
          after: { pending },
        });
        throw new Error('after-audit failure');
      }),
    ).rejects.toThrow('after-audit failure');
    expect((await read('quantenlos.pending'))?.value).toEqual(pending);
    expect(await owner.clientReminder.count({ where: { tenantId } })).toBe(0);
    expect(await owner.auditLog.count({ where: { tenantId } })).toBe(0);
    await transaction((tx) => state.claimLosPendingTx(tx, tenantId, pending));
  });

  it('only the original start attempt may finish and its consumed reservation rolls back on failure', async () => {
    await transaction((tx) => state.reserveLosStartTx(tx, tenantId, start, staffId));
    await expect(
      transaction((tx) => state.claimLosStartTx(tx, tenantId, randomUUID())),
    ).rejects.toThrow(/bereits bearbeitet/);
    await expect(
      transaction(async (tx) => {
        await state.claimLosStartTx(tx, tenantId, start.attemptId);
        await tx.tenantSetting.create({
          data: { tenantId, key: 'quantenlos.pending', value: pending },
        });
        throw new Error('audit unavailable');
      }),
    ).rejects.toThrow('audit unavailable');
    expect((await read('quantenlos.start'))?.value).toEqual(start);
    expect(await read('quantenlos.pending')).toBeNull();
  });

  it('a stale recovery or release cannot consume a subsequently saved engine response', async () => {
    await transaction((tx) => state.reserveLosStartTx(tx, tenantId, start, staffId));
    const accepted = { ...start, engineResponse: { status: 'wartet', job_id: 'actual-job' } };
    await owner.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: 'quantenlos.start' } },
      data: { value: accepted },
    });
    await expect(
      transaction((tx) => state.claimLosStartTx(tx, tenantId, start.attemptId, start)),
    ).rejects.toThrow(/bereits bearbeitet/);
    expect((await read('quantenlos.start'))?.value).toEqual(accepted);
  });
});
