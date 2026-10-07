// Fachkatalog: AUDIT-RFC3161-ANCHOR-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): TSA-Auswahl der Worker über die App-Rolle.
//
// Die Tenant-Einstellung `evidence.tsa` liest selectTsaUrl im SYSTEM-Kontext
// des Tenants über taxtronik_app (RLS); der Owner-Client ist hier vollständig
// gesperrt. Belegt: dieselbe Auswahl wie bisher (Tenant-Preset vor ENV und
// Default), und die Einstellung eines fremden Tenants bleibt für Tenant A
// unsichtbar und wirkungslos.
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
} from './app-role-db';

const enabled = process.env['WORKER_DB_TEST'] === '1';
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('./app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { selectTsaUrl } from '../tsa-port';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 TSA selection via the app role', () => {
  let owner: Owner;
  let a = '';
  let b = '';
  let withoutSetting = '';

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a = await createTenantFixture(owner, 'tsa-a');
    b = await createTenantFixture(owner, 'tsa-b');
    withoutSetting = await createTenantFixture(owner, 'tsa-none');
    await owner.tenantSetting.createMany({
      data: [
        { tenantId: a, key: 'evidence.tsa', value: { providerId: 'freetsa', customUrl: '' } },
        {
          tenantId: b,
          key: 'evidence.tsa',
          value: { providerId: 'custom', customUrl: 'https://tsa-b.example.test/tsr' },
        },
      ],
    });
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a, b, withoutSetting]);
  });

  it('wählt die TSA des Tenants wie bisher, ohne Owner-Zugriff', async () => {
    resetOwnerAccess();
    expect(await selectTsaUrl(a)).toEqual({ url: 'https://freetsa.org/tsr', source: 'tenant' });
    expect(await selectTsaUrl(b)).toEqual({
      url: 'https://tsa-b.example.test/tsr',
      source: 'tenant',
    });
    // Ohne eigene Einstellung gilt ENV bzw. der Default, nie die Wahl eines anderen Tenants.
    expect((await selectTsaUrl(withoutSetting))?.source).not.toBe('tenant');
    expect(ownerAccess.denied).toEqual([]);
    expect(ownerAccess.allowed).toEqual([]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Einstellung von Tenant B', async () => {
    expect(
      await withSystemContext(a, (tx) => tx.tenantSetting.findMany({ where: { tenantId: b } })),
    ).toEqual([]);
  });
});
