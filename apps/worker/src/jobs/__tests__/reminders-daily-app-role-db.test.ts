// Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): reminders-daily über die App-Rolle.
//
// Kandidatensuche (Einspruchsfristen, Wiedervorlagen, Pendelordner) und die
// Abschnittstransaktionen (Sperren, Revalidierung, Zugriffsfilter, Insert)
// laufen im SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Der
// Owner-Client ist in dieser Suite gesperrt. Belegt: dieselben Hinweise wie
// zuvor aus allen drei Quellen (Frist in 7 Tagen an den Prüfer, fällige und
// interne Wiedervorlage, überfälliger Pendelordner), keine Wiederholung am
// selben Tag, und fällige Vorgänge eines fremden Tenants bleiben unsichtbar.
// Die Mengen- und Abschnittslogik belegt weiterhin reminders-daily-db.test.ts.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1); eigene Tenants,
// die am Ende samt Kaskade gelöscht werden.
// =============================================================================

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

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
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
import '../reminders-daily';

const describeDb = enabled ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('S-01 reminders-daily via the app role', () => {
  let owner: Owner;
  const today = berlinTodayUtcMidnight(new Date());
  const a = { tenant: '', hb: '', admin: '', client: '', notice: '', reminder: '', internal: '' };
  const binder = { a: '' };
  const b = { tenant: '', staff: '', client: '', reminder: '' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a.tenant = await createTenantFixture(owner, 'reminders-daily-a');
    a.hb = await createStaffFixture(owner, a.tenant, { name: 'reminders-daily-a-hb' });
    a.admin = await createStaffFixture(owner, a.tenant, {
      name: 'reminders-daily-a-admin',
      role: 'ADMIN',
    });
    a.client = await createClientFixture(owner, a.tenant, 'reminders-daily-a');
    // Wie bescheid-vorab-db.test.ts: geprüfter Bescheid mit berechneter Frist.
    const appealDeadline = new Date(today.getTime() + 7 * DAY_MS);
    const noticeDate = new Date(appealDeadline.getTime() - 40 * DAY_MS);
    a.notice = (
      await owner.taxNotice.create({
        data: {
          tenantId: a.tenant,
          clientId: a.client,
          kind: 'EST',
          period: '2025',
          createdByStaff: a.hb,
          recipientName: 'Empfangsbevollmächtigte Kanzlei',
          recipientCountryCode: 'DE',
          recipientRegion: 'DE-BE',
          recipientLocality: 'Berlin',
          recipientHolidayContextStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION',
          authorityName: 'Finanzamt Berlin',
          authorityCountryCode: 'DE',
          authorityRegion: 'DE-BE',
          authorityLocality: 'Berlin',
          authorityHolidayContextStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION',
          holidayContextNote: 'Örtliche Feiertage für Datum und beide Orte geprüft.',
          deliveryEvidenceNote: 'Ausgangsvorgang anhand der Akte geprüft.',
          legalRemedyInstructionNote: 'Pflichtangaben und Einzelfall geprüft.',
          noticeDate,
          status: 'GEPRUEFT',
          reviewedAt: noticeDate,
          reviewedBy: a.hb,
          dateBasis: 'DISPATCH_DATE',
          deliveryEvidenceStatus: 'SUBSTANTIATED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          calculatedNotificationDate: new Date(noticeDate.getTime() + 4 * DAY_MS),
          appealDeadline,
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: 'tax-legal-assessment/2026-08-23-v1',
          manualReviewRequired: false,
        },
        select: { id: true },
      })
    ).id;
    a.reminder = (
      await owner.clientReminder.create({
        data: {
          tenantId: a.tenant,
          clientId: a.client,
          dueDate: today,
          subject: 'Unterlagen anfordern',
          createdByStaff: a.hb,
        },
        select: { id: true },
      })
    ).id;
    a.internal = (
      await owner.clientReminder.create({
        data: {
          tenantId: a.tenant,
          clientId: null,
          dueDate: new Date(today.getTime() - DAY_MS),
          subject: 'Intern',
          createdByStaff: a.admin,
        },
        select: { id: true },
      })
    ).id;
    binder.a = (
      await owner.pendingBinder.create({
        data: {
          tenantId: a.tenant,
          clientId: a.client,
          label: 'Ordner 2025',
          status: 'WITH_CLIENT',
          sentAt: new Date(today.getTime() - 10 * DAY_MS),
          expectedReturnAt: new Date(today.getTime() - 2 * DAY_MS),
          createdByStaff: a.hb,
        },
        select: { id: true },
      })
    ).id;

    b.tenant = await createTenantFixture(owner, 'reminders-daily-b');
    b.staff = await createStaffFixture(owner, b.tenant, { name: 'reminders-daily-b' });
    b.client = await createClientFixture(owner, b.tenant, 'reminders-daily-b');
    b.reminder = (
      await owner.clientReminder.create({
        data: {
          tenantId: b.tenant,
          clientId: b.client,
          dueDate: today,
          subject: 'Fremd',
          createdByStaff: b.staff,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  const run = () => processors.get('reminders-daily')!({ data: { tenantId: a.tenant } });

  it('schreibt dieselben Tageshinweise wie bisher, ohne den Owner-Client', async () => {
    resetOwnerAccess();
    expect(await run()).toEqual({ appeal: 1, reminders: 2, binders: 1 });

    const notes = await owner.notification.findMany({
      where: { tenantId: a.tenant },
      select: { staffId: true, kind: true, resourceId: true },
    });
    expect(notes.map((note) => `${note.kind}|${note.staffId}|${note.resourceId}`).sort()).toEqual(
      [
        `CLIENT_REMINDER_DUE|${a.admin}|${a.internal}`,
        `CLIENT_REMINDER_DUE|${a.hb}|${a.reminder}`,
        `PENDING_BINDER_OVERDUE|${a.hb}|${binder.a}`,
        `TAX_NOTICE_APPEAL_REMINDER|${a.hb}|${a.notice}`,
      ].sort(),
    );
    // Derselbe Tag: nichts Neues.
    expect(await run()).toEqual({ appeal: 0, reminders: 0, binders: 0 });
    expect(await owner.notification.count({ where: { tenantId: a.tenant } })).toBe(4);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('lässt die fällige Wiedervorlage eines fremden Tenants unsichtbar und ohne Hinweis', async () => {
    expect(await owner.notification.count({ where: { tenantId: b.tenant } })).toBe(0);
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.clientReminder.findMany({ where: { id: b.reminder } }),
      ),
    ).toEqual([]);
  });
});
