// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): Modulschalter der Worker-Jobs über die App-Rolle.
//
// readWorkerTenantModules liest tenant_setting `modules` im SYSTEM-Kontext des
// Tenants über taxtronik_app. Der Owner-Client ist in dieser Suite gesperrt;
// jeder Zugriff darauf ließe sie scheitern. Belegt: dieselben Schalter wie
// zuvor (eigener Eintrag, Voreinstellung ohne Eintrag), und im Kontext von
// Tenant A bleiben die Einstellungen von Tenant B unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1); eigene Tenants,
// die am Ende samt Kaskade gelöscht werden.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createTenantFixture,
  deleteTenantFixtures,
  ownerAccess,
  type Owner,
} from './app-role-db';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('./app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import {
  DEFAULT_BOOLEAN_TENANT_MODULES,
  readBooleanTenantModules,
} from '@taxtronik/db/tenant-modules';
import { isWorkerTenantModuleEnabled, readWorkerTenantModules } from '../module-gate';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 module gate via the app role', () => {
  let owner: Owner;
  let tenantA = '';
  let tenantB = '';
  let tenantC = '';

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    tenantA = await createTenantFixture(owner, 'module-gate-a');
    tenantB = await createTenantFixture(owner, 'module-gate-b');
    tenantC = await createTenantFixture(owner, 'module-gate-c');
    await owner.tenantSetting.createMany({
      data: [
        { tenantId: tenantA, key: 'modules', value: { reminders: false, risk: true } },
        { tenantId: tenantB, key: 'modules', value: { workflows: false, risk: false } },
      ],
    });
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [tenantA, tenantB, tenantC]);
  });

  it('liest die Schalter jedes Tenants wie bisher, ohne den Owner-Client', async () => {
    expect(await readWorkerTenantModules(tenantA)).toEqual({
      ...DEFAULT_BOOLEAN_TENANT_MODULES,
      reminders: false,
      risk: true,
    });
    expect(await readWorkerTenantModules(tenantB)).toEqual({
      ...DEFAULT_BOOLEAN_TENANT_MODULES,
      workflows: false,
      risk: false,
    });
    // Ohne Eintrag gelten die Voreinstellungen.
    expect(await readWorkerTenantModules(tenantC)).toEqual(DEFAULT_BOOLEAN_TENANT_MODULES);
    expect(await isWorkerTenantModuleEnabled(tenantA, 'reminders')).toBe(false);
    expect(await isWorkerTenantModuleEnabled(tenantA, 'risk')).toBe(true);
    expect(await isWorkerTenantModuleEnabled(tenantB, 'workflows')).toBe(false);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Einstellungen von Tenant B', async () => {
    const foreign = await withSystemContext(tenantA, async (tx) => ({
      rows: await tx.tenantSetting.findMany({ where: { tenantId: tenantB } }),
      modules: await readBooleanTenantModules(tx, tenantB),
    }));
    expect(foreign.rows).toEqual([]);
    // Mit BYPASSRLS stünde hier workflows=false aus dem Eintrag von Tenant B.
    expect(foreign.modules).toEqual(DEFAULT_BOOLEAN_TENANT_MODULES);
    // Gegenprobe: der Owner sieht die Zeile, sie existiert also.
    expect(await owner.tenantSetting.count({ where: { tenantId: tenantB } })).toBe(1);
  });
});
