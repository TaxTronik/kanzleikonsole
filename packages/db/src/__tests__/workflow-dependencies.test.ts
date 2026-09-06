// Fachkatalog: WORKFLOW-DEPENDENCY-001
// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
const run =
  process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL'] ? describe : describe.skip;

run('WORKFLOW-DEPENDENCY-001 actual period and reopen boundaries', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
  });
  let tenantId: string,
    staffId: string,
    recipientId: string,
    predecessor: string,
    successor: string,
    workflowId: string,
    successorClient: string;
  async function actor<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, id = staffId) {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true),set_config('app.current_actor_id',${id},true),set_config('app.current_actor_type','STAFF',true)`;
      return fn(tx);
    });
  }
  async function item(year: number | null, assignedTo = staffId) {
    const client = await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Synthetic dependency client' },
    });
    const workflow = await owner.workflowInstance.create({
      data: {
        tenantId,
        clientId: client.id,
        name: 'Synthetic workflow',
        assessmentYear: year,
        startedByStaff: staffId,
      },
    });
    const step = await owner.workflowItem.create({
      data: {
        instanceId: workflow.id,
        title: 'Synthetic step',
        position: 0,
        assigneeStaffId: assignedTo,
      },
    });
    return { client, workflow, step };
  }
  const connect = (from: string, to: string) =>
    actor((tx) =>
      tx.workflowDependency.create({
        data: { tenantId, createdBy: staffId, predecessorItemId: from, successorItemId: to },
      }),
    );
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tenantId = (
      await owner.tenant.create({
        data: { slug: `dependency-${suffix}`, name: 'Isolated dependency tests' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `admin-${suffix}@example.test`,
          fullName: 'Admin',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    recipientId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `assignee-${suffix}@example.test`,
          fullName: 'Assignee',
          passwordHash: 'x',
        },
      })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'modules', value: { workflowDependencies: true } },
    });
    const a = await item(2026);
    const b = await item(2026, recipientId);
    predecessor = a.step.id;
    successor = b.step.id;
    workflowId = a.workflow.id;
    successorClient = b.client.id;
  });
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  it('requires two explicitly confirmed identical periods', async () => {
    const unknown = await item(null);
    const otherYear = await item(2025);
    await expect(connect(unknown.step.id, successor)).rejects.toThrow(
      'same confirmed assessment year',
    );
    await expect(connect(otherYear.step.id, successor)).rejects.toThrow(
      'same confirmed assessment year',
    );
    expect((await connect(predecessor, successor)).successorItemId).toBe(successor);
    expect(
      (
        await actor((tx) =>
          tx.workflowInstance.findUniqueOrThrow({ where: { id: unknown.workflow.id } }),
        )
      ).assessmentYear,
    ).toBeNull();
  });
  it('keeps connected periods fixed and still rejects indirect cycles', async () => {
    await expect(
      actor((tx) =>
        tx.workflowInstance.update({ where: { id: workflowId }, data: { assessmentYear: 2025 } }),
      ),
    ).rejects.toThrow('Remove workflow dependencies');
    const third = await item(2026);
    await connect(successor, third.step.id);
    await expect(connect(third.step.id, predecessor)).rejects.toThrow('Dependency cycle');
  });
  it('notifies the active assignee on a real reopen without changing downstream status', async () => {
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: new Date() } }),
    );
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: null } }),
    );
    const notifications = await actor(
      (tx) =>
        tx.notification.findMany({
          where: { kind: 'WORKFLOW_PREREQUISITE_REOPENED', clientId: successorClient },
        }),
      recipientId,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      staffId: recipientId,
      resourceType: 'client',
      resourceId: successorClient,
    });
    expect(JSON.stringify(notifications)).not.toContain(predecessor);
    expect(
      (await actor((tx) => tx.workflowItem.findUniqueOrThrow({ where: { id: successor } }))).doneAt,
    ).toBeNull();
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: null } }),
    );
    expect(
      await owner.notification.count({
        where: { kind: 'WORKFLOW_PREREQUISITE_REOPENED', clientId: successorClient },
      }),
    ).toBe(1);
  });
  it('hides existing notices and skips new notices after assignee access is withdrawn', async () => {
    await owner.client.update({ where: { id: successorClient }, data: { vertraulich: true } });
    expect(
      await actor(
        (tx) =>
          tx.notification.findMany({
            where: { kind: 'WORKFLOW_PREREQUISITE_REOPENED', clientId: successorClient },
          }),
        recipientId,
      ),
    ).toEqual([]);
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: new Date() } }),
    );
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: null } }),
    );
    expect(
      await owner.notification.count({
        where: { kind: 'WORKFLOW_PREREQUISITE_REOPENED', clientId: successorClient },
      }),
    ).toBe(1);
  });
  it('pauses reopen notifications while the module is disabled', async () => {
    await owner.client.update({ where: { id: successorClient }, data: { vertraulich: false } });
    await owner.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: 'modules' } },
      data: { value: { workflowDependencies: false } },
    });
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: new Date() } }),
    );
    await actor((tx) =>
      tx.workflowItem.update({ where: { id: predecessor }, data: { doneAt: null } }),
    );
    expect(
      await owner.notification.count({
        where: { kind: 'WORKFLOW_PREREQUISITE_REOPENED', clientId: successorClient },
      }),
    ).toBe(1);
  });
});
