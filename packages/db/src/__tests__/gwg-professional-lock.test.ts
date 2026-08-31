// Fachkatalog: GWG-RISK-REVIEW-001, ACCESS-STAFF-PERMISSION-001.
// Real PostgreSQL lock evidence; no GwG decision or professional approval is written.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const racer = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tenantId: string;
let clientId: string;
let staffId: string;
let lockStaffGwgReviewerTx: (
  tx: Pick<TxClient, '$queryRaw' | 'clientResponsibility'>,
  input: { tenantId: string; clientId: string; staffId: string },
) => Promise<boolean>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function backendId(tx: TxClient) {
  const [backend] = await tx.$queryRaw<
    Array<{ pid: number }>
  >`SELECT pg_backend_pid()::integer AS pid`;
  return backend!.pid;
}

async function waitsFor(pid: number, blockerPid: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [state] = await owner.$queryRaw<
      Array<{ blockers: number[] }>
    >`SELECT pg_blocking_pids(${pid}::integer) AS blockers`;
    if (state?.blockers.includes(blockerPid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function reviewerContext(tx: TxClient) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8s'");
  await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true), set_config('app.current_actor_type', 'STAFF', true), set_config('app.current_actor_id', ${staffId}, true)`;
  const key = `gwg-check-lifecycle:${tenantId}:${clientId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

beforeAll(async () => {
  // Import the actual pure web helper at runtime. A computed path avoids pulling
  // the web project into packages/db's TypeScript rootDir; no SQL replica is tested.
  const helperPath = new URL(
    '../../../../apps/web/src/server/gwg/professional-review.ts',
    import.meta.url,
  ).href;
  ({ lockStaffGwgReviewerTx } = await import(helperPath));
  const stamp = Date.now();
  tenantId = (
    await owner.tenant.create({
      data: { slug: `gwg-review-lock-${stamp}`, name: 'Synthetic review locks' },
    })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Synthetic lock client' },
    })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `review-lock-${stamp}@example.test`,
        fullName: 'Synthetic reviewer',
        passwordHash: 'x',
        active: true,
        isProfessional: true,
      },
    })
  ).id;
});

beforeEach(async () => {
  await owner.staffUser.update({
    where: { id: staffId },
    data: { active: true, isProfessional: true },
  });
  await owner.staffRole.upsert({
    where: { staffUserId_role: { staffUserId: staffId, role: 'EMPLOYEE' } },
    create: { staffUserId: staffId, role: 'EMPLOYEE' },
    update: {},
  });
  await owner.clientResponsibility.upsert({
    where: { clientId_staffId_role: { clientId, staffId, role: 'BERUFSTRAEGER' } },
    create: { tenantId, clientId, staffId, role: 'BERUFSTRAEGER' },
    update: {},
  });
});

afterAll(async () => {
  try {
    if (tenantId) expect(await owner.gwgCheck.count({ where: { tenantId } })).toBe(0);
  } finally {
    if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), racer.$disconnect(), app.$disconnect()]);
  }
});

const revocations = [
  {
    name: 'qualification UPDATE',
    mutate: (tx: TxClient) =>
      tx.staffUser.update({ where: { id: staffId }, data: { isProfessional: false } }),
  },
  {
    name: 'professional assignment DELETE',
    mutate: (tx: TxClient) =>
      tx.clientResponsibility.deleteMany({
        where: { tenantId, clientId, staffId, role: 'BERUFSTRAEGER' },
      }),
  },
  {
    name: 'last staff role DELETE',
    mutate: (tx: TxClient) => tx.staffRole.deleteMany({ where: { staffUserId: staffId } }),
  },
];

describe('GWG-RISK-REVIEW-001 reviewer locks through transaction commit', () => {
  it.each(revocations)(
    '$name waits until the eligible decision transaction commits',
    async ({ mutate }) => {
      const ready = deferred<{ eligible: boolean; pid: number }>();
      const release = deferred<void>();
      const mutationPid = deferred<number>();
      const decision = app.$transaction(
        async (tx) => {
          await reviewerContext(tx);
          const eligible = await lockStaffGwgReviewerTx(tx, { tenantId, clientId, staffId });
          ready.resolve({ eligible, pid: await backendId(tx) });
          await release.promise;
          return eligible;
        },
        { timeout: 12_000 },
      );
      let mutation: Promise<unknown> | undefined;
      try {
        const locked = await Promise.race([
          ready.promise,
          decision.then(() => {
            throw new Error('Decision ended before lock observation');
          }),
        ]);
        expect(locked.eligible).toBe(true);
        mutation = racer.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8s'");
            mutationPid.resolve(await backendId(tx));
            return mutate(tx);
          },
          { timeout: 12_000 },
        );
        const pid = await Promise.race([
          mutationPid.promise,
          mutation.then(() => {
            throw new Error('Revocation completed before lock observation');
          }),
        ]);
        expect(await waitsFor(pid, locked.pid)).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled([decision, ...(mutation ? [mutation] : [])]);
      }
      await expect(decision).resolves.toBe(true);
      await expect(mutation).resolves.toBeDefined();
    },
    15_000,
  );

  it('waits for an earlier revocation and denies eligibility after that commit', async () => {
    const revoked = deferred<number>();
    const release = deferred<void>();
    const reviewerPid = deferred<number>();
    const revocation = racer.$transaction(
      async (tx) => {
        await tx.staffUser.update({ where: { id: staffId }, data: { isProfessional: false } });
        revoked.resolve(await backendId(tx));
        await release.promise;
      },
      { timeout: 12_000 },
    );
    let decision: Promise<boolean> | undefined;
    try {
      const blocker = await Promise.race([
        revoked.promise,
        revocation.then(() => {
          throw new Error('Revocation ended before lock observation');
        }),
      ]);
      decision = app.$transaction(
        async (tx) => {
          await reviewerContext(tx);
          reviewerPid.resolve(await backendId(tx));
          return lockStaffGwgReviewerTx(tx, { tenantId, clientId, staffId });
        },
        { timeout: 12_000 },
      );
      const pid = await Promise.race([
        reviewerPid.promise,
        decision.then(() => {
          throw new Error('Decision ended before lock observation');
        }),
      ]);
      expect(await waitsFor(pid, blocker)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([revocation, ...(decision ? [decision] : [])]);
    }
    await expect(revocation).resolves.toBeUndefined();
    await expect(decision).resolves.toBe(false);
  }, 15_000);
});
