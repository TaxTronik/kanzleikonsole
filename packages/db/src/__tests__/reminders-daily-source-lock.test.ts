import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Reminder-Lock-Regression braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const racer = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let staffId: string;
let reminderId: string;
const dueDate = new Date('2026-08-24T00:00:00.000Z');

beforeAll(async () => {
  const stamp = Date.now();
  tenantId = (
    await owner.tenant.create({
      data: { slug: `reminder-lock-${stamp}`, name: 'Reminder Lock Regression' },
    })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `reminder-lock-${stamp}@test.local`,
        fullName: 'Reminder Lock Staff',
        passwordHash: 'x',
      },
    })
  ).id;
  reminderId = (
    await owner.clientReminder.create({
      data: {
        tenantId,
        dueDate,
        subject: 'Gleichzeitig erledigte Wiedervorlage',
        createdByStaff: staffId,
      },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), racer.$disconnect()]);
});

async function waitForBackendLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await owner.$queryRaw<Array<{ waiting: boolean }>>(
      Prisma.sql`SELECT COALESCE(wait_event_type = 'Lock', FALSE) AS waiting
                   FROM pg_stat_activity
                  WHERE pid = ${pid}`,
    );
    if (activity?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describeWithDatabase('reminders-daily Source-Row-Lock', () => {
  // Fachkatalog: TAX-CONTROL-STATUS-001
  it('wartet auf eine laufende Erledigung und verwirft danach den stale Kandidaten', async () => {
    let releaseUpdate!: () => void;
    let updateReady!: () => void;
    let reportWorkerPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      updateReady = resolve;
    });
    const workerPid = new Promise<number>((resolve) => {
      reportWorkerPid = resolve;
    });

    const completingTransaction = racer.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
        await tx.$queryRaw(
          Prisma.sql`SELECT "id"
                       FROM public."client_reminder"
                      WHERE "tenant_id" = ${tenantId}::uuid
                        AND "id" = ${reminderId}::uuid
                      FOR UPDATE`,
        );
        await tx.clientReminder.update({
          where: { id: reminderId },
          data: { doneAt: new Date('2026-08-24T08:00:00.000Z'), doneByStaff: staffId },
        });
        updateReady();
        await release;
      },
      { timeout: 10_000 },
    );

    await updated;
    const workerTransaction = owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid()::integer AS pid`,
        );
        reportWorkerPid(backend!.pid);

        // Dieselbe feste Lock-/Recheck-/Insert-Sequenz wie im Worker. Der
        // zugehörige Worker-Unit-Test bindet diese Regression an die konkrete
        // Implementierung in reminders-daily.ts.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id"
                       FROM public."client_reminder"
                      WHERE "tenant_id" = ${tenantId}::uuid
                        AND "id" IN (${reminderId}::uuid)
                      ORDER BY "id"
                      FOR UPDATE`,
        );
        const current = await tx.clientReminder.findMany({
          where: { id: reminderId, tenantId, doneAt: null, dueDate },
          select: { id: true },
        });
        if (current.length > 0) {
          await tx.notification.create({
            data: {
              tenantId,
              staffId,
              kind: 'CLIENT_REMINDER_DUE',
              title: 'Dieser stale Hinweis darf nicht entstehen',
              resourceType: 'client_reminder',
              resourceId: reminderId,
            },
          });
        }
      },
      { timeout: 10_000 },
    );

    try {
      expect(await waitForBackendLock(await workerPid)).toBe(true);
    } finally {
      releaseUpdate();
    }

    await expect(completingTransaction).resolves.toBeUndefined();
    await expect(workerTransaction).resolves.toBeUndefined();
    expect(
      await owner.notification.count({
        where: { tenantId, resourceType: 'client_reminder', resourceId: reminderId },
      }),
    ).toBe(0);
  }, 15_000);
});
