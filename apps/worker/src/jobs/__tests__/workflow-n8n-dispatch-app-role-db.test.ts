// Fachkatalog: WORKFLOW-LIFECYCLE-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): workflow-n8n-dispatch über die App-Rolle.
//
// Laden, Claim, Verbuchung und Abschluss eines n8n-Handoffs laufen im
// SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Beim Owner-Client
// bleibt nur die mandantenübergreifende Suche fälliger Handoffs (ID und
// Tenant); sie ist hier auf die Fixture-Tenants begrenzt. Die Outbox-Übergabe
// (n8n-emit) ist eine Attrappe. Belegt: derselbe Abschluss wie bisher
// (Handoff übergeben, Schritt erledigt mit dem Staff-Snapshot, Audit
// workflow.item.execute), kein weiterer Owner-Zugriff, und der offene Handoff
// eines fremden Tenants bleibt unberührt und im Kontext von Tenant A
// unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen in der Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createClientFixture,
  createStaffFixture,
  createTenantFixture,
  deleteTenantFixtures,
  ownerAccess,
  resetOwnerAccess,
  type Owner,
} from '../../__tests__/app-role-db';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const h = vi.hoisted(() => ({ tenants: [] as string[], emit: vi.fn() }));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../n8n-emit', () => ({ emitN8nEventFromWorker: h.emit }));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  const real = actual.prismaOwner;
  return {
    ...actual,
    prismaOwner: guardOwnerClient(real, ['workflowN8nDispatch.findMany', '$queryRaw'], {
      // Die Suchen des Jobs, begrenzt auf die Tenants dieser Suite.
      'workflowN8nDispatch.findMany': (async (args: { where: object }) =>
        real.workflowN8nDispatch.findMany({
          ...(args as object),
          where: { AND: [args.where, { tenantId: { in: h.tenants } }] },
        } as Parameters<typeof real.workflowN8nDispatch.findMany>[0])) as never,
      $queryRaw: (async (...args: Parameters<typeof real.$queryRaw>) =>
        ((await real.$queryRaw(...args)) as Array<{ tenantId: string }>).filter((row) =>
          h.tenants.includes(row.tenantId),
        )) as never,
    }),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { runWorkflowN8nDispatch } from '../workflow-n8n-dispatch';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 workflow-n8n-dispatch via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', staff: '', item: '', dispatch: '' };
  const b = { tenant: '', staff: '', item: '', dispatch: '' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    for (const [fixture, label] of [
      [a, 'dispatch-a'],
      [b, 'dispatch-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.staff = await createStaffFixture(owner, fixture.tenant, { name: label });
      const clientId = await createClientFixture(owner, fixture.tenant, label);
      const instance = await owner.workflowInstance.create({
        data: {
          tenantId: fixture.tenant,
          clientId,
          name: `Synthetic ${label}`,
          startedByStaff: fixture.staff,
        },
        select: { id: true },
      });
      fixture.item = (
        await owner.workflowItem.create({
          data: {
            instanceId: instance.id,
            position: 0,
            title: `Synthetic n8n step ${label}`,
            kind: 'N8N_TRIGGER',
          },
          select: { id: true },
        })
      ).id;
      fixture.dispatch = (
        await owner.workflowN8nDispatch.create({
          data: {
            itemId: fixture.item,
            tenantId: fixture.tenant,
            actorStaffId: fixture.staff,
            event: 'workflow.step.custom.trigger',
            payload: { itemId: fixture.item },
            createdAt: new Date(Date.now() - 60_000),
          },
          select: { id: true },
        })
      ).id;
    }
    h.tenants = [a.tenant];
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('übergibt den Handoff und schließt den Schritt wie bisher ab, ohne Owner-Zugriff auf Mandantendaten', async () => {
    resetOwnerAccess();
    const eventId = randomUUID();
    h.emit.mockResolvedValue({ eventId, status: 'PENDING', deliveryCount: 1 });

    await expect(runWorkflowN8nDispatch()).resolves.toEqual({
      claimed: 1,
      enqueued: 1,
      settled: 0,
      failed: 0,
    });

    expect(h.emit).toHaveBeenCalledWith(
      'workflow.step.custom.trigger',
      { itemId: a.item },
      {
        tenantId: a.tenant,
        dedupeKey: `workflow-dispatch:${a.dispatch}`,
      },
    );
    expect(
      await owner.workflowN8nDispatch.findUniqueOrThrow({
        where: { id: a.dispatch },
        select: { outboxId: true, attemptCount: true, claimedAt: true, enqueuedAt: true },
      }),
    ).toEqual({
      outboxId: eventId,
      attemptCount: 1,
      claimedAt: null,
      enqueuedAt: expect.any(Date),
    });
    expect(
      await owner.workflowItem.findUniqueOrThrow({
        where: { id: a.item },
        select: { doneAt: true, doneByStaff: true },
      }),
    ).toEqual({ doneAt: expect.any(Date), doneByStaff: a.staff });
    expect(
      await owner.auditLog.findMany({
        where: { tenantId: a.tenant },
        select: { action: true, actorType: true, actorId: true, resourceId: true },
      }),
    ).toEqual([
      {
        action: 'workflow.item.execute',
        actorType: 'STAFF',
        actorId: a.staff,
        resourceId: a.item,
      },
    ]);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)].sort()).toEqual([
      '$queryRaw',
      'workflowN8nDispatch.findMany',
    ]);
  });

  it('lässt den offenen Handoff eines fremden Tenants unberührt und unsichtbar', async () => {
    expect(
      await owner.workflowN8nDispatch.findUniqueOrThrow({
        where: { id: b.dispatch },
        select: { claimedAt: true, enqueuedAt: true, attemptCount: true },
      }),
    ).toEqual({ claimedAt: null, enqueuedAt: null, attemptCount: 0 });
    expect(
      await withSystemContext(a.tenant, async (tx) => ({
        dispatches: await tx.workflowN8nDispatch.findMany({ where: { id: b.dispatch } }),
        items: await tx.workflowItem.findMany({ where: { id: b.item } }),
      })),
    ).toEqual({ dispatches: [], items: [] });
  });
});
