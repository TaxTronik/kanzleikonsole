// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): update-check über die App-Rolle.
//
// Das Prüfergebnis schreibt der Job je Tenant im SYSTEM-Kontext über
// taxtronik_app (RLS). Beim Owner-Client bleibt nur die Tenant-Liste; sie ist
// hier auf die Fixture-Tenants begrenzt, der Abruf des Manifests ist eine
// Attrappe. Belegt: dasselbe tenant_setting wie bisher (angelegt und beim
// nächsten Lauf überschrieben), kein weiterer Owner-Zugriff, und die
// Einstellung eines fremden Tenants bleibt unverändert und im Kontext von
// Tenant A unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1).
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createTenantFixture,
  deleteTenantFixtures,
  ownerAccess,
  resetOwnerAccess,
  type Owner,
} from '../../__tests__/app-role-db';

const enabled = process.env['WORKER_DB_TEST'] === '1';
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const scope = vi.hoisted(() => ({ tenants: [] as string[] }));

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
    prismaOwner: guardOwnerClient(actual.prismaOwner, ['tenant.findMany'], {
      'tenant.findMany': async () => scope.tenants.map((id) => ({ id })),
    }),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { UPDATE_CHECK_RESULT_SETTING_KEY } from '@taxtronik/config/update-manifest';
import { prismaOwner as guardedOwner } from '../../prisma-owner';
import { runUpdateCheck, storeUpdateCheckResult } from '../update-check';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 update-check via the app role', () => {
  let owner: Owner;
  let a = '';
  let b = '';
  const foreignValue = { checkedAt: '2026-01-01T00:00:00.000Z', ok: false, error: 'fremd' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a = await createTenantFixture(owner, 'update-check-a');
    b = await createTenantFixture(owner, 'update-check-b');
    await owner.tenantSetting.create({
      data: { tenantId: b, key: UPDATE_CHECK_RESULT_SETTING_KEY, value: foreignValue },
    });
    scope.tenants = [a];
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a, b]);
  });

  it('speichert und überschreibt das Ergebnis wie bisher, ohne Owner-Zugriff auf Mandantendaten', async () => {
    resetOwnerAccess();
    const run = (now: string) =>
      runUpdateCheck({
        check: async () => ({ ok: false, error: 'Server nicht erreichbar' }),
        tenantIds: async () =>
          (await guardedOwner.tenant.findMany({ select: { id: true } })).map((tenant) => tenant.id),
        store: storeUpdateCheckResult,
        now: () => new Date(now),
      });

    await run('2026-10-05T12:00:00.000Z');
    const second = await run('2026-10-06T12:00:00.000Z');

    expect(
      await owner.tenantSetting.findMany({
        where: { tenantId: { in: [a, b] }, key: UPDATE_CHECK_RESULT_SETTING_KEY },
        select: { tenantId: true, value: true },
        orderBy: { tenantId: 'asc' },
      }),
    ).toEqual(
      [
        { tenantId: a, value: second },
        { tenantId: b, value: foreignValue },
      ].sort((left, right) => (left.tenantId < right.tenantId ? -1 : 1)),
    );
    expect(second).toMatchObject({ checkedAt: '2026-10-06T12:00:00.000Z', ok: false });
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)]).toEqual(['tenant.findMany']);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Einstellung von Tenant B', async () => {
    expect(
      await withSystemContext(a, (tx) => tx.tenantSetting.findMany({ where: { tenantId: b } })),
    ).toEqual([]);
  });
});
