// Fachkatalog: INV-DUE-OVERDUE-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): invoice-overdue-check über die App-Rolle.
//
// Kandidatensuche, Statuswechsel SENT → OVERDUE, Audit und Hinweis laufen im
// SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Der Owner-Client ist in
// dieser Suite gesperrt (die mandantenübergreifende Tenant-Liste wird mit
// tenantId im Auftrag nicht gebraucht). Belegt: dieselben Zeilen wie zuvor
// (überfällig erst ab dem Folgetag, Stornorechnungen ausgenommen) und eine
// überfällige Rechnung eines fremden Tenants bleibt unsichtbar und unverändert.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen und GwG-Prüfungen in der
// Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createActiveClientFixture,
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
import { processors } from './mocks/bullmq';
import { berlinTodayUtcMidnight } from '../../date-util';
import '../invoice-overdue-check';

const describeDb = enabled ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('S-01 invoice-overdue-check via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', creator: '', client: '', overdue: '', dueToday: '', storno: '' };
  const b = { tenant: '', creator: '', client: '', overdue: '' };

  async function sentInvoice(
    tenantId: string,
    clientId: string,
    createdByStaff: string,
    dueDate: Date,
    extra: { stornoOfId?: string; amount?: number } = {},
  ): Promise<string> {
    const amount = extra.amount ?? 119;
    const invoice = await owner.invoice.create({
      data: {
        tenantId,
        clientId,
        number: `S01-${randomUUID()}`,
        subject: 'Synthetic invoice',
        issueDate: new Date(dueDate.getTime() - 14 * DAY_MS),
        dueDate,
        netAmount: amount / 1.19,
        vatAmount: amount - amount / 1.19,
        totalAmount: amount,
        vatRate: 19,
        createdByStaff,
        ...(extra.stornoOfId ? { stornoOfId: extra.stornoOfId } : {}),
      },
      select: { id: true },
    });
    await owner.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT' } });
    return invoice.id;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    const today = berlinTodayUtcMidnight(new Date());
    for (const [fixture, label] of [
      [a, 'invoice-overdue-a'],
      [b, 'invoice-overdue-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.creator = await createStaffFixture(owner, fixture.tenant, { name: label });
      fixture.client = await createActiveClientFixture(
        owner,
        fixture.tenant,
        fixture.creator,
        label,
      );
      fixture.overdue = await sentInvoice(
        fixture.tenant,
        fixture.client,
        fixture.creator,
        new Date(today.getTime() - 3 * DAY_MS),
      );
    }
    // Fälligkeit heute: Zahlung ist noch rechtzeitig (§ 271 BGB).
    a.dueToday = await sentInvoice(a.tenant, a.client, a.creator, today);
    // Stornorechnung (negativer Betrag) ist keine offene Forderung.
    a.storno = await sentInvoice(
      a.tenant,
      a.client,
      a.creator,
      new Date(today.getTime() - 5 * DAY_MS),
      {
        stornoOfId: a.overdue,
        amount: -119,
      },
    );
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('setzt dieselben Rechnungen auf OVERDUE und benachrichtigt wie bisher, ohne den Owner-Client', async () => {
    resetOwnerAccess();
    const result = await processors.get('invoice-overdue-check')!({ data: { tenantId: a.tenant } });

    expect(result).toEqual({ updated: 1, notified: 1 });
    const statuses = await owner.invoice.findMany({
      where: { tenantId: a.tenant },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [a.overdue]: 'OVERDUE',
      [a.dueToday]: 'SENT',
      [a.storno]: 'SENT',
    });
    const notes = await owner.notification.findMany({
      where: { tenantId: a.tenant },
      select: { staffId: true, kind: true, title: true, resourceId: true },
    });
    expect(notes).toEqual([
      {
        staffId: a.creator,
        kind: 'INVOICE_OVERDUE',
        title: expect.stringMatching(/ überfällig \(3 Tage\)$/),
        resourceId: a.overdue,
      },
    ]);
    const audit = await owner.auditLog.findMany({
      where: { tenantId: a.tenant, action: 'invoice.overdue' },
      select: { actorType: true, resourceId: true, after: true },
    });
    expect(audit).toEqual([
      {
        actorType: 'SYSTEM',
        resourceId: a.overdue,
        after: { status: 'OVERDUE', daysOverdue: 3 },
      },
    ]);
    expect(ownerAccess.denied).toEqual([]);
    expect(ownerAccess.allowed).toEqual([]);
  });

  it('lässt die überfällige Rechnung eines fremden Tenants unsichtbar und unverändert', async () => {
    expect(
      await owner.invoice.findUniqueOrThrow({ where: { id: b.overdue }, select: { status: true } }),
    ).toEqual({ status: 'SENT' });
    expect(await owner.notification.count({ where: { tenantId: b.tenant } })).toBe(0);
    expect(
      await withSystemContext(a.tenant, (tx) => tx.invoice.findMany({ where: { id: b.overdue } })),
    ).toEqual([]);
  });
});
