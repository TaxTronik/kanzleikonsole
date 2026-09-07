// Fachkatalog: REMINDER-TICKET-001, ACCESS-TENANT-RLS-001, TAX-CONTROL-STATUS-001.
// Real PostgreSQL: allocation, durable references, archive and source lifecycle.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '../prisma-adapter';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(requireDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL')),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(
    requireDatabaseUrl(process.env.DATABASE_APP_URL, 'DATABASE_APP_URL'),
  ),
});
const tenants: string[] = [];
let staffId: string;
const context = <T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  actorType = 'STAFF',
) =>
  app.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true),
    set_config('app.current_actor_id',${staffId},true),
    set_config('app.current_actor_type',${actorType},true)`;
      return fn(tx);
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

function data(tenantId = tenants[0]!) {
  return {
    tenantId,
    createdByStaff: staffId,
    subject: 'Synthetic ticket',
    dueDate: new Date('2026-09-07'),
  };
}
const create = () => context(tenants[0]!, (tx) => tx.clientReminder.create({ data: data() }));

beforeAll(async () => {
  for (let n = 0; n < 2; n++) {
    tenants.push(
      (
        await owner.tenant.create({
          data: {
            slug: 'reminder-ticket-test-' + crypto.randomUUID(),
            name: 'Synthetic ticket test',
          },
        })
      ).id,
    );
  }
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId: tenants[0]!,
        email: crypto.randomUUID() + '@example.test',
        fullName: 'Synthetic ticket admin',
        passwordHash: 'unused',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
});

afterAll(async () => {
  for (const id of tenants) await owner.tenant.delete({ where: { id } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe('REMINDER-TICKET-001 immutable tenant ticket numbers', () => {
  it('allocates automatically in all direct inserts and starts independently for each tenant', async () => {
    const a = await create();
    const b = await owner.clientReminder.create({ data: data(tenants[1]!) });
    expect(a.ticketNumber).toBe(1);
    expect(b.ticketNumber).toBe(1);
  });

  it('serializes 16 simultaneous writers without duplicate numbers', async () => {
    const records = await Promise.all(Array.from({ length: 16 }, () => create()));
    const numbers = records.map((record) => record.ticketNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 16 }, (_, i) => i + 2));
  });

  it('rolls the counter and inserted row back together on a failed transaction', async () => {
    const before = await owner.clientReminderCounter.findUniqueOrThrow({
      where: { tenantId: tenants[0]! },
    });
    const rollback = new Error('ROLLBACK_TICKET_FIXTURE');
    await expect(
      context(tenants[0]!, async (tx) => {
        await tx.clientReminder.create({ data: data() });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      await owner.clientReminderCounter.findUniqueOrThrow({ where: { tenantId: tenants[0]! } }),
    ).toEqual(before);
    expect((await create()).ticketNumber).toBe(before.lastNumber + 1);
  });

  it('never reuses an issued number after an authorized hard deletion', async () => {
    const old = await create();
    await owner.clientReminder.delete({ where: { id: old.id } });
    expect((await create()).ticketNumber).toBeGreaterThan(old.ticketNumber);
  });

  it('rejects caller-selected numbers, including negative input', async () => {
    for (const ticketNumber of [-1, 1000000]) {
      await expect(
        context(tenants[0]!, (tx) =>
          tx.clientReminder.create({
            data: { ...data(), ticketNumber },
          }),
        ),
      ).rejects.toThrow('automatisch');
    }
  });

  it('keeps the UUID, tenant and number immutable even in owner maintenance', async () => {
    const ticket = await create();
    for (const change of [
      { ticketNumber: ticket.ticketNumber + 100 },
      { tenantId: tenants[1]! },
      { id: crypto.randomUUID() },
    ]) {
      await expect(
        owner.clientReminder.update({ where: { id: ticket.id }, data: change }),
      ).rejects.toThrow('unveränderlich');
    }
  });

  it('denies all direct app reads/writes to the allocation counter', async () => {
    await expect(
      context(tenants[0]!, (tx) => tx.clientReminderCounter.findMany()),
    ).rejects.toThrow();
    await expect(
      context(tenants[0]!, (tx) =>
        tx.clientReminderCounter.update({
          where: { tenantId: tenants[0]! },
          data: { lastNumber: 1 },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('REMINDER-TICKET-001 archive and permanent directed references', () => {
  it('allows simultaneous reciprocal references while both writers hold their source lock', async () => {
    const a = await create();
    const b = await create();
    let locked = 0;
    let release!: () => void;
    const bothLocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = (sourceReminderId: string, targetReminderId: string) =>
      context(tenants[0]!, async (tx) => {
        await tx.$queryRaw`SELECT id FROM public.client_reminder
          WHERE id=${sourceReminderId}::uuid FOR NO KEY UPDATE`;
        locked++;
        if (locked === 2) release();
        await bothLocked;
        return tx.clientReminderReference.create({
          data: {
            tenantId: tenants[0]!,
            sourceReminderId,
            targetReminderId,
          },
        });
      });
    const results = await Promise.allSettled([write(a.id, b.id), write(b.id, a.id)]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    expect(failures).toEqual([]);
    expect(
      await owner.clientReminderReference.count({
        where: {
          OR: [
            { sourceReminderId: a.id, targetReminderId: b.id },
            { sourceReminderId: b.id, targetReminderId: a.id },
          ],
        },
      }),
    ).toBe(2);
  });

  it('makes a waiting writer observe the committed archive state after its row lock', async () => {
    const ticket = await create();
    let release!: () => void;
    let locked!: () => void;
    let started!: (pid: number) => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const archiveWritten = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const waitingPid = new Promise<number>((resolve) => {
      started = resolve;
    });
    const archive = context(tenants[0]!, async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.client_reminder WHERE id=${ticket.id}::uuid FOR NO KEY UPDATE`;
      await tx.clientReminder.update({
        where: { id: ticket.id },
        data: {
          doneAt: new Date(),
          doneByStaff: staffId,
          archivedAt: new Date(),
          archivedByStaff: staffId,
        },
      });
      locked();
      await hold;
    });
    await archiveWritten;
    let reachedRead = false;
    const waiting = context(tenants[0]!, async (tx) => {
      const [connection] = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`;
      started(connection!.pid);
      await tx.$queryRaw`SELECT id FROM public.client_reminder WHERE id=${ticket.id}::uuid FOR NO KEY UPDATE`;
      reachedRead = true;
      return tx.clientReminder.findUniqueOrThrow({ where: { id: ticket.id } });
    });
    try {
      const pid = await waitingPid;
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [state] = await owner.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
        blocked = state!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(reachedRead).toBe(false);
    } finally {
      release();
      const [, observed] = await Promise.all([archive, waiting]);
      expect(observed.archivedAt).not.toBeNull();
      expect(observed.doneAt).not.toBeNull();
      expect(observed.doneByStaff).toBe(staffId);
    }
  });

  it('preserves both identities and the backlink through archive and restore', async () => {
    const source = await create();
    const target = await create();
    const link = await context(tenants[0]!, (tx) =>
      tx.clientReminderReference.create({
        data: {
          tenantId: tenants[0]!,
          sourceReminderId: source.id,
          targetReminderId: target.id,
        },
      }),
    );
    await context(tenants[0]!, (tx) =>
      tx.clientReminder.update({
        where: { id: target.id },
        data: {
          doneAt: new Date(),
          doneByStaff: staffId,
          archivedAt: new Date(),
          archivedByStaff: staffId,
        },
      }),
    );
    const archived = await context(tenants[0]!, (tx) =>
      tx.clientReminder.findUniqueOrThrow({
        where: {
          tenantId_ticketNumber: { tenantId: tenants[0]!, ticketNumber: target.ticketNumber },
        },
        include: { incomingReferences: { include: { sourceReminder: true } } },
      }),
    );
    expect(archived.id).toBe(target.id);
    expect(archived.incomingReferences[0]?.sourceReminder.id).toBe(source.id);
    const restored = await context(tenants[0]!, (tx) =>
      tx.clientReminder.update({
        where: { id: target.id },
        data: { archivedAt: null, archivedByStaff: null },
      }),
    );
    expect(restored.doneAt).not.toBeNull();
    expect(restored.ticketNumber).toBe(target.ticketNumber);
    expect(
      await owner.clientReminderReference.findUnique({ where: { id: link.id } }),
    ).not.toBeNull();
  });

  it('rejects archive of open tickets and reopening without leaving the archive', async () => {
    const ticket = await create();
    await expect(
      context(tenants[0]!, (tx) =>
        tx.clientReminder.update({
          where: { id: ticket.id },
          data: {
            archivedAt: new Date(),
            archivedByStaff: staffId,
          },
        }),
      ),
    ).rejects.toThrow();
    await owner.clientReminder.update({
      where: { id: ticket.id },
      data: {
        doneAt: new Date(),
        doneByStaff: staffId,
        archivedAt: new Date(),
        archivedByStaff: staffId,
      },
    });
    await expect(
      owner.clientReminder.update({ where: { id: ticket.id }, data: { doneAt: null } }),
    ).rejects.toThrow();
  });

  it('requires the archive actor and timestamp as one state', async () => {
    const ticket = await create();
    await expect(
      owner.clientReminder.update({
        where: { id: ticket.id },
        data: {
          doneAt: new Date(),
          archivedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('keeps a legacy completion without its actor outside the archive', async () => {
    const ticket = await create();
    await owner.clientReminder.update({ where: { id: ticket.id }, data: { doneAt: new Date() } });
    await expect(
      owner.clientReminder.update({
        where: { id: ticket.id },
        data: {
          archivedAt: new Date(),
          archivedByStaff: staffId,
        },
      }),
    ).rejects.toThrow();
  });

  it('deduplicates repeated mentions and rejects self references', async () => {
    const a = await create();
    const b = await create();
    const edge = { tenantId: tenants[0]!, sourceReminderId: a.id, targetReminderId: b.id };
    await context(tenants[0]!, (tx) =>
      tx.clientReminderReference.createMany({ data: [edge, edge], skipDuplicates: true }),
    );
    expect(await owner.clientReminderReference.count({ where: { sourceReminderId: a.id } })).toBe(
      1,
    );
    await expect(
      owner.clientReminderReference.create({ data: { ...edge, targetReminderId: a.id } }),
    ).rejects.toThrow();
  });

  it('prevents cross-tenant links at both FK ends, even using the owner', async () => {
    const a = await create();
    const foreign = await owner.clientReminder.create({ data: data(tenants[1]!) });
    for (const ids of [
      { sourceReminderId: a.id, targetReminderId: foreign.id },
      { sourceReminderId: foreign.id, targetReminderId: a.id },
    ]) {
      await expect(
        owner.clientReminderReference.create({ data: { tenantId: tenants[0]!, ...ids } }),
      ).rejects.toThrow();
    }
  });

  it('hides references from other tenants, portal actors and missing context', async () => {
    const a = await create();
    const b = await create();
    const edge = await owner.clientReminderReference.create({
      data: {
        tenantId: tenants[0]!,
        sourceReminderId: a.id,
        targetReminderId: b.id,
      },
    });
    for (const actor of [
      { tenant: tenants[1]!, type: 'STAFF' },
      { tenant: tenants[0]!, type: 'CLIENT_CONTACT' },
    ]) {
      expect(
        await context(
          actor.tenant,
          (tx) => tx.clientReminderReference.findUnique({ where: { id: edge.id } }),
          actor.type,
        ),
      ).toBeNull();
    }
    expect(await app.clientReminderReference.findUnique({ where: { id: edge.id } })).toBeNull();
  });

  it('denies app removal/rewiring and cascades only actual parent deletion', async () => {
    const a = await create();
    const b = await create();
    const link = await owner.clientReminderReference.create({
      data: {
        tenantId: tenants[0]!,
        sourceReminderId: a.id,
        targetReminderId: b.id,
      },
    });
    await expect(
      context(tenants[0]!, (tx) => tx.clientReminderReference.delete({ where: { id: link.id } })),
    ).rejects.toThrow();
    await expect(
      context(tenants[0]!, (tx) =>
        tx.clientReminderReference.update({
          where: { id: link.id },
          data: { createdAt: new Date(0) },
        }),
      ),
    ).rejects.toThrow();
    await owner.clientReminder.delete({ where: { id: b.id } });
    expect(await owner.clientReminderReference.findUnique({ where: { id: link.id } })).toBeNull();
    expect(await owner.clientReminder.findUnique({ where: { id: a.id } })).not.toBeNull();
  });
});

async function marking(tenantId = tenants[0]!) {
  const analysis = await owner.riskAnalysis.create({
    data: {
      tenantId,
      sourceText: 'Synthetic source',
      textHash: 'synthetic',
      katalogVersion: 'test',
      engineVersion: 'test',
      createdById: staffId,
    },
  });
  return owner.riskMarking.create({
    data: {
      tenantId,
      analysisId: analysis.id,
      start: 0,
      end: 9,
      matchedText: 'Synthetic',
      herkunft: 'BERATER',
      begriff: 'Synthetic',
      normAnker: [],
    },
  });
}

describe('REMINDER-TICKET-001 durable research origin', () => {
  it('retains the original marking after a new delegation replaces its current ticket', async () => {
    const origin = await marking();
    const original = await owner.clientReminder.create({
      data: { ...data(), originRiskMarkingId: origin.id },
    });
    await owner.riskMarking.update({ where: { id: origin.id }, data: { reminderId: original.id } });
    const next = await owner.clientReminder.create({
      data: { ...data(), originRiskMarkingId: origin.id },
    });
    await owner.riskMarking.update({ where: { id: origin.id }, data: { reminderId: next.id } });
    const historical = await owner.clientReminder.findUniqueOrThrow({
      where: { id: original.id },
      include: { originRiskMarking: true },
    });
    expect(historical.originRiskMarking?.id).toBe(origin.id);
    expect(historical.originRiskMarking?.reminderId).toBe(next.id);
  });

  it('rejects foreign origins and replacement/clearing of a live source', async () => {
    const origin = await marking();
    const other = await marking();
    const foreign = await marking(tenants[1]!);
    await expect(
      owner.clientReminder.create({ data: { ...data(), originRiskMarkingId: foreign.id } }),
    ).rejects.toThrow();
    const ticket = await owner.clientReminder.create({
      data: { ...data(), originRiskMarkingId: origin.id },
    });
    for (const originRiskMarkingId of [other.id, null]) {
      await expect(
        owner.clientReminder.update({ where: { id: ticket.id }, data: { originRiskMarkingId } }),
      ).rejects.toThrow('unveränderlich');
    }
  });

  it('removes only the source pointer on real marking deletion, preserving tenant and ticket', async () => {
    const origin = await marking();
    const ticket = await owner.clientReminder.create({
      data: { ...data(), originRiskMarkingId: origin.id },
    });
    await owner.riskMarking.delete({ where: { id: origin.id } });
    const remaining = await owner.clientReminder.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(remaining.originRiskMarkingId).toBeNull();
    expect(remaining.tenantId).toBe(ticket.tenantId);
    expect(remaining.ticketNumber).toBe(ticket.ticketNumber);
  });
});
