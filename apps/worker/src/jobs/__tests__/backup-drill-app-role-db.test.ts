// Fachkatalog: BACKUP-DRILL-INTEGRITY-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): backup-drill speichert Ergebnisse über die App-Rolle.
//
// Der Restore-Drill bleibt Betriebswartung: Tenant-Liste und die
// installationsweite Backup-Historie liest der Owner-Client, die Wegwerf-DB
// legt die Drill-Rolle an. Ergebnis, Audit-Eintrag und Hinweise je Tenant
// schreibt der Job im SYSTEM-Kontext des Tenants über taxtronik_app (RLS).
// Belegt über den Pfad ohne erfolgreiches Backup (Owner-Lesepfade sind auf die
// Fixture-Tenants bzw. „kein Backup“ begrenzt): dasselbe Ergebnis, derselbe
// Audit-Eintrag backup.drill.failed und dieselben Hinweise an aktive
// ADMIN/PARTNER wie bisher, kein weiterer Owner-Zugriff, und ein fremder
// Tenant bleibt ohne Ergebnis und im Kontext von Tenant A unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen in der Wegwerf-Datenbank.
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

const scope = vi.hoisted(() => ({ tenants: [] as Array<{ id: string; createdAt: Date }> }));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return {
    ...actual,
    prismaOwner: guardOwnerClient(
      actual.prismaOwner,
      ['tenant.findMany', 'backupRecord.findFirst'],
      {
        'tenant.findMany': async () => scope.tenants,
        'backupRecord.findFirst': async () => null,
      },
    ),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { BACKUP_DRILL_RESULT_SETTING_KEY } from '@taxtronik/evidence';
import { processors } from './mocks/bullmq';
import '../backup-drill';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 backup-drill results via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', admin: '', employee: '' };
  const b = { tenant: '', admin: '' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a.tenant = await createTenantFixture(owner, 'drill-a');
    a.admin = await createStaffFixture(owner, a.tenant, { name: 'drill-admin', role: 'ADMIN' });
    a.employee = await createStaffFixture(owner, a.tenant, { name: 'drill-employee' });
    b.tenant = await createTenantFixture(owner, 'drill-b');
    b.admin = await createStaffFixture(owner, b.tenant, { name: 'drill-b-admin', role: 'ADMIN' });
    const tenantA = await owner.tenant.findUniqueOrThrow({
      where: { id: a.tenant },
      select: { id: true, createdAt: true },
    });
    scope.tenants = [tenantA];
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('speichert Ergebnis, Audit und Hinweis wie bisher, ohne Owner-Zugriff auf Mandantendaten', async () => {
    resetOwnerAccess();
    await expect(processors.get('backup-drill')!({ data: {} })).resolves.toEqual({
      ok: false,
      tenants: 1,
    });

    const stored = await owner.tenantSetting.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: a.tenant, key: BACKUP_DRILL_RESULT_SETTING_KEY } },
      select: { value: true },
    });
    expect(stored.value).toMatchObject({
      ok: false,
      backupKey: null,
      error: 'Kein erfolgreiches Backup vorhanden — Restore-Test nicht möglich.',
    });
    expect(
      await owner.auditLog.findMany({
        where: { tenantId: a.tenant },
        select: { action: true, actorType: true },
      }),
    ).toEqual([{ action: 'backup.drill.failed', actorType: 'SYSTEM' }]);
    expect(
      await owner.notification.findMany({
        where: { tenantId: a.tenant },
        select: { staffId: true, kind: true, resourceType: true, resourceId: true },
      }),
    ).toEqual([
      {
        staffId: a.admin,
        kind: 'SYSTEM_BACKUP_FAILED',
        resourceType: 'backup_drill',
        resourceId: 'none',
      },
    ]);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)].sort()).toEqual([
      'backupRecord.findFirst',
      'tenant.findMany',
    ]);
  });

  it('lässt einen fremden Tenant ohne Ergebnis und im Kontext von Tenant A unsichtbar', async () => {
    expect(
      await owner.tenantSetting.count({
        where: { tenantId: b.tenant, key: BACKUP_DRILL_RESULT_SETTING_KEY },
      }),
    ).toBe(0);
    expect(
      await withSystemContext(a.tenant, async (tx) => ({
        staff: await tx.staffUser.findMany({ where: { id: b.admin } }),
        settings: await tx.tenantSetting.findMany({ where: { tenantId: b.tenant } }),
      })),
    ).toEqual({ staff: [], settings: [] });
  });
});
