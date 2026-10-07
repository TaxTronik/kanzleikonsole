// Fachkatalog: AUDIT-VERIFY-ALERT-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): audit-verify-check schreibt Ergebnis und Hinweise über
// die App-Rolle.
//
// Die Kettenprüfung selbst läuft weiter in Owner-Transaktionen (sie schreibt
// die Prüf-Checkpoints, die App-Rolle hat dort nur SELECT). Vorgänger- und
// Recovery-Einstellungen, das Ergebnis und alle Hinweise liest und schreibt
// der Job im SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Belegt mit
// einem manuellen Lauf über eine leere Kette: dasselbe Ergebnis und dieselben
// Hinweise wie bisher (offene Bruchmeldungen erledigt, Abschlussmeldung an den
// Auslöser), Bruchmeldungen nur an aktive ADMIN/PARTNER des Tenants, keine
// Owner-Zugriffe außer den Prüftransaktionen, und die Hinweise eines fremden
// Tenants bleiben unberührt und im Kontext von Tenant A unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die TSA-Prüfung
// fällt außerhalb von Produktion auf den lokalen Zeitstempel zurück.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
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
// Kein DNS-Zugriff im Test: die TSA-Auswahl fällt lokal auf den Self-Timestamp zurück.
vi.mock('../../http/ssrf-guard', () => ({
  assertPublicHost: async () => {
    throw new Error('offline test');
  },
}));
// Die Owner-Transaktionen der Kettenprüfung dürfen weder Einstellungen noch
// Hinweise oder Mitarbeiter anfassen; das liefe am Tenant-Kontext vorbei.
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient, ownerAccess } = await import('../../__tests__/app-role-db');
  const real = actual.prismaOwner;
  const forbidden = new Set(['tenantSetting', 'notification', 'staffUser']);
  const $transaction = (fn: (tx: unknown) => Promise<unknown>, options?: object) =>
    real.$transaction(
      (tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              if (typeof prop === 'string' && forbidden.has(prop)) {
                ownerAccess.denied.push(`$transaction.${prop}`);
                throw new Error(`S-01: Owner-Transaktion für ${prop} benutzt`);
              }
              return Reflect.get(target, prop);
            },
          }),
        ),
      options,
    );
  return {
    ...actual,
    prismaOwner: guardOwnerClient(real, ['$transaction'], {
      $transaction: $transaction as never,
    }),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { AUDIT_VERIFY_RESULT_SETTING_KEY } from '@taxtronik/evidence';
import { processors } from './mocks/bullmq';
import { notifyAuditBreak } from '../audit-verify-check';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 audit-verify-check results and notifications via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', admin: '', partner: '', employee: '', inactive: '' };
  const b = { tenant: '', admin: '' };

  async function openBreak(tenantId: string, staffId: string) {
    await owner.notification.create({
      data: {
        tenantId,
        staffId,
        kind: 'SYSTEM_AUDIT_BREAK',
        title: 'Synthetischer Bruch',
        href: '/staff/admin/audit',
        resourceType: 'audit_log',
      },
    });
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a.tenant = await createTenantFixture(owner, 'audit-verify-a');
    a.admin = await createStaffFixture(owner, a.tenant, { name: 'av-admin', role: 'ADMIN' });
    a.partner = await createStaffFixture(owner, a.tenant, { name: 'av-partner', role: 'PARTNER' });
    a.employee = await createStaffFixture(owner, a.tenant, { name: 'av-employee' });
    a.inactive = await createStaffFixture(owner, a.tenant, {
      name: 'av-inactive',
      role: 'ADMIN',
      active: false,
    });
    b.tenant = await createTenantFixture(owner, 'audit-verify-b');
    b.admin = await createStaffFixture(owner, b.tenant, { name: 'av-b-admin', role: 'ADMIN' });
    await openBreak(a.tenant, a.admin);
    await openBreak(b.tenant, b.admin);
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('speichert das Ergebnis und meldet den Abschluss wie bisher, ohne Owner-Zugriff außer der Prüfung', async () => {
    resetOwnerAccess();
    await expect(
      processors.get('audit-verify-check')!({
        data: { tenantId: a.tenant, requestedByStaffId: a.admin, requestId: 's01-request' },
      }),
    ).resolves.toEqual({ results: [{ tenantId: a.tenant, ok: true }] });

    const stored = await owner.tenantSetting.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: a.tenant, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
      select: { value: true },
    });
    expect(stored.value).toMatchObject({ ok: true, requestId: 's01-request', checked: 0 });
    // Offene Bruchmeldung erledigt, Abschlussmeldung an den Auslöser.
    expect(
      await owner.notification.findMany({
        where: { tenantId: a.tenant },
        select: { staffId: true, kind: true, readAt: true },
        orderBy: { kind: 'asc' },
      }),
    ).toEqual([
      { staffId: a.admin, kind: 'SYSTEM_AUDIT_BREAK', readAt: expect.any(Date) },
      { staffId: a.admin, kind: 'SYSTEM_AUDIT_OK', readAt: null },
    ]);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)]).toEqual(['$transaction']);
  });

  it('meldet Brüche nur an aktive ADMIN/PARTNER des Tenants', async () => {
    resetOwnerAccess();
    await notifyAuditBreak(a.tenant, { body: 'Bruch bei 42', resourceId: '42' });

    expect(
      (
        await owner.notification.findMany({
          where: { tenantId: a.tenant, kind: 'SYSTEM_AUDIT_BREAK', resourceId: '42' },
          select: { staffId: true },
        })
      )
        .map((row) => row.staffId)
        .sort(),
    ).toEqual([a.admin, a.partner].sort());
    expect(ownerAccess.denied).toEqual([]);
    expect(ownerAccess.allowed).toEqual([]);
  });

  it('lässt die Hinweise eines fremden Tenants unberührt und unsichtbar', async () => {
    expect(
      await owner.notification.findMany({
        where: { tenantId: b.tenant },
        select: { staffId: true, kind: true, readAt: true },
      }),
    ).toEqual([{ staffId: b.admin, kind: 'SYSTEM_AUDIT_BREAK', readAt: null }]);
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.notification.findMany({ where: { tenantId: b.tenant } }),
      ),
    ).toEqual([]);
  });
});
