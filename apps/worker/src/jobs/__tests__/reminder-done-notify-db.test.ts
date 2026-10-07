// Fachkatalog: REMINDER-TICKET-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): reminder-done-notify über die App-Rolle.
//
// Der Job liest Wiedervorlage, Empfängerberechtigung und Namen und schreibt den
// Hinweis im SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Der
// Owner-Client ist in dieser Suite gesperrt. Belegt: derselbe Hinweis wie
// zuvor, keiner für eine zurückgeholte Wiedervorlage, und eine Wiedervorlage
// eines fremden Tenants bleibt unsichtbar, auch wenn ihre ID im Auftrag steht.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1); eigene Tenants,
// die am Ende samt Kaskade gelöscht werden.
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { processors } from './mocks/bullmq';
import '../reminder-done-notify';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 reminder-done-notify via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', admin: '', delegator: '', client: '', done: '', reopened: '' };
  const b = { tenant: '', admin: '', delegator: '', client: '', done: '' };

  async function doneReminder(
    tenantId: string,
    clientId: string,
    createdByStaff: string,
    doneByStaff: string | null,
    subject: string,
  ): Promise<string> {
    const reminder = await owner.clientReminder.create({
      data: {
        tenantId,
        clientId,
        dueDate: new Date(Date.UTC(2026, 9, 1)),
        subject,
        createdByStaff,
        doneAt: doneByStaff ? new Date() : null,
        doneByStaff,
      },
      select: { id: true },
    });
    return reminder.id;
  }

  const run = (data: { tenantId: string; reminderId: string; staffId: string }) =>
    processors.get(JOB_QUEUES.reminderDoneNotify.name)!({ data });

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    for (const [fixture, label] of [
      [a, 'reminder-done-a'],
      [b, 'reminder-done-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.admin = await createStaffFixture(owner, fixture.tenant, {
        name: `${label}-admin`,
        role: 'ADMIN',
      });
      fixture.delegator = await createStaffFixture(owner, fixture.tenant, {
        name: `${label}-delegator`,
      });
      fixture.client = await createClientFixture(owner, fixture.tenant, label);
      fixture.done = await doneReminder(
        fixture.tenant,
        fixture.client,
        fixture.delegator,
        fixture.admin,
        `Unterlagen ${label}`,
      );
    }
    a.reopened = await doneReminder(a.tenant, a.client, a.delegator, null, 'Zurückgeholt');
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  beforeEach(async () => {
    resetOwnerAccess();
    await owner.notification.deleteMany({ where: { tenantId: { in: [a.tenant, b.tenant] } } });
  });

  it('schreibt denselben Hinweis wie bisher, ohne den Owner-Client', async () => {
    await run({ tenantId: a.tenant, reminderId: a.done, staffId: a.delegator });

    const notes = await owner.notification.findMany({
      where: { tenantId: a.tenant },
      select: {
        staffId: true,
        kind: true,
        title: true,
        body: true,
        href: true,
        resourceType: true,
        resourceId: true,
      },
    });
    expect(notes).toEqual([
      {
        staffId: a.delegator,
        kind: 'CLIENT_REMINDER_DONE',
        title: 'Wiedervorlage erledigt: Unterlagen reminder-done-a',
        body: 'Synthetic reminder-done-a-admin hat die von dir delegierte Wiedervorlage abgeschlossen.',
        href: `/staff/clients/${a.client}`,
        resourceType: 'client_reminder',
        resourceId: a.done,
      },
    ]);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('schreibt nichts für eine zurückgeholte Wiedervorlage', async () => {
    await run({ tenantId: a.tenant, reminderId: a.reopened, staffId: a.delegator });
    expect(await owner.notification.count({ where: { tenantId: a.tenant } })).toBe(0);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('sieht die Wiedervorlage eines fremden Tenants nicht, auch mit ihrer ID im Auftrag', async () => {
    await run({ tenantId: a.tenant, reminderId: b.done, staffId: a.delegator });

    expect(
      await owner.notification.count({ where: { tenantId: { in: [a.tenant, b.tenant] } } }),
    ).toBe(0);
    // RLS: im SYSTEM-Kontext von A ist die Zeile von B unsichtbar; der Owner sieht sie.
    const foreign = await withSystemContext(a.tenant, (tx) =>
      tx.clientReminder.findMany({ where: { id: b.done } }),
    );
    expect(foreign).toEqual([]);
    expect(await owner.clientReminder.count({ where: { id: b.done } })).toBe(1);
    expect(ownerAccess.denied).toEqual([]);
  });
});
