// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001, TAX-DEADLINE-WORKDAY-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): tax-deadline-materialize über die App-Rolle.
//
// Der gemeinsame Kern (@taxtronik/tax) und der persistierte
// Benachrichtigungsfluss laufen im Worker jetzt im SYSTEM-Kontext des Tenants
// über taxtronik_app (RLS): Einzelabfragen über systemContextClient (je Aufruf
// eine kurze Transaktion, wie zuvor beim Owner-Client), atomare Blöcke über
// withSystemContext. Der Owner-Client ist in dieser Suite gesperrt, der
// Mailversand (@taxtronik/mail) ist eine Attrappe. Belegt: Termine aus dem
// Zeitplan, Auto-Anforderung mit Audit für jeden Termin im Versandfenster,
// Benachrichtigung nach Commit (PROVIDER_ACCEPTED), ein abgelaufener Termin wird
// OVERDUE, und der Zeitplan eines fremden Tenants bleibt unsichtbar und
// unverarbeitet.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen und GwG-Prüfungen in der
// Wegwerf-Datenbank.
// =============================================================================

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

const enabled = process.env['WORKER_DB_TEST'] === '1';
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const mail = vi.hoisted(() => ({ calls: [] as Array<{ tenantId: string; requestId: string }> }));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../mail', () => ({
  notifyAutomaticTaxRequestOpened: async (input: { tenantId: string; requestId: string }) => {
    mail.calls.push({ tenantId: input.tenantId, requestId: input.requestId });
    return {
      ok: true,
      recipients: 1,
      attempted: 1,
      externalSideEffectOccurred: true,
      uncertainFailure: false,
    };
  },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { processors } from './mocks/bullmq';
import '../tax-deadline-materialize';

const describeDb = enabled ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('S-01 tax-deadline-materialize via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', admin: '', client: '', config: '', past: '' };
  const b = { tenant: '', admin: '', client: '', config: '' };

  async function scheduledClient(fixture: typeof a | typeof b, label: string) {
    fixture.tenant = await createTenantFixture(owner, label);
    fixture.admin = await createStaffFixture(owner, fixture.tenant, {
      name: `${label}-admin`,
      role: 'ADMIN',
    });
    fixture.client = await createActiveClientFixture(owner, fixture.tenant, fixture.admin, label);
    // Versandfenster über einen Monat: jeder nächste Monatstermin löst die
    // Auto-Anforderung ohne Vorwarnung aus, unabhängig vom Testdatum.
    fixture.config = (
      await owner.taxScheduleConfig.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          kind: 'USTA_MONATLICH',
          active: true,
          hasDauerfrist: false,
          autoRequest: true,
          reminderDaysBefore: 45,
          staffLeadDays: 0,
          createdByStaff: fixture.admin,
        },
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    await scheduledClient(a, 'tax-materialize-a');
    await scheduledClient(b, 'tax-materialize-b');
    // Ein längst fälliger, noch geplanter Termin wird OVERDUE.
    a.past = (
      await owner.taxDeadline.create({
        data: {
          tenantId: a.tenant,
          clientId: a.client,
          kind: 'EST_VZ',
          period: '2020-Q1',
          dueDate: new Date(Date.now() - 30 * DAY_MS),
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('materialisiert, fordert an und benachrichtigt wie bisher, ohne den Owner-Client', async () => {
    resetOwnerAccess();
    await processors.get('tax-deadline-materialize')!({ data: { tenantId: a.tenant } });

    const deadlines = await owner.taxDeadline.findMany({
      where: { tenantId: a.tenant, configId: a.config },
      select: {
        id: true,
        status: true,
        requestId: true,
        autoRequestNotificationStatus: true,
        request: { select: { tenantId: true, clientId: true, createdByStaff: true } },
      },
    });
    // 90-Tage-Horizont: mindestens zwei Monatstermine.
    expect(deadlines.length).toBeGreaterThanOrEqual(2);
    const requested = deadlines.filter((deadline) => deadline.requestId !== null);
    expect(requested.length).toBeGreaterThanOrEqual(1);
    for (const deadline of requested) {
      expect(deadline.status).toBe('REMINDED');
      expect(deadline.autoRequestNotificationStatus).toBe('PROVIDER_ACCEPTED');
      expect(deadline.request).toEqual({
        tenantId: a.tenant,
        clientId: a.client,
        createdByStaff: a.admin,
      });
    }
    expect(mail.calls.map((call) => call.requestId).sort()).toEqual(
      requested.map((deadline) => deadline.requestId).sort(),
    );
    expect(new Set(mail.calls.map((call) => call.tenantId))).toEqual(new Set([a.tenant]));
    expect(
      await owner.auditLog.count({
        where: { tenantId: a.tenant, action: 'tax_deadline.auto_request' },
      }),
    ).toBe(requested.length);
    expect(
      await owner.taxDeadline.findUniqueOrThrow({
        where: { id: a.past },
        select: { status: true },
      }),
    ).toEqual({ status: 'OVERDUE' });
    expect(ownerAccess.denied).toEqual([]);
  });

  it('lässt den Zeitplan eines fremden Tenants unsichtbar und unverarbeitet', async () => {
    expect(await owner.taxDeadline.count({ where: { tenantId: b.tenant } })).toBe(0);
    expect(await owner.request.count({ where: { tenantId: b.tenant } })).toBe(0);
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.taxScheduleConfig.findMany({ where: { id: b.config } }),
      ),
    ).toEqual([]);
  });
});
