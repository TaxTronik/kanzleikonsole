// Fachkatalog: AUDIT-RFC3161-ANCHOR-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): audit-anchor liest und schreibt den Anchor-Status über
// die App-Rolle.
//
// Fällige Tenants, Lease und Anker bleiben beim Owner-Client (die App-Rolle hat
// am Lease keine Rechte und darf Anker nicht ändern). Den Status je Tenant
// (tenant_setting audit_anchor_status) liest und schreibt der Job im
// SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Außerhalb von Produktion
// fällt die TSA-Auswahl hier auf den lokalen Zeitstempel zurück; der Lauf
// endet dann ohne Lease und Netz mit dem Status LOCAL_ONLY. Belegt: derselbe
// Status wie bisher, ein älterer Versuch überschreibt keinen neueren, kein
// Owner-Zugriff, und der Status eines fremden Tenants bleibt unverändert und
// im Kontext von Tenant A unsichtbar.
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
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { AUDIT_ANCHOR_STATUS_SETTING_KEY } from '@taxtronik/evidence';
import { processors } from './mocks/bullmq';
import '../audit-anchor';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 audit-anchor status via the app role', () => {
  let owner: Owner;
  let a = '';
  let b = '';
  const future = {
    state: 'ANCHORED',
    lastAttemptAt: '2999-01-01T00:00:00.000Z',
    lastSuccessAt: '2999-01-01T00:00:00.000Z',
    lastAnchoredAuditId: '7',
    tsaGenTime: '2999-01-01T00:00:00.000Z',
    trustAnchored: true,
    consecutiveFailures: 0,
    nextRetryAt: null,
    error: null,
  };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a = await createTenantFixture(owner, 'anchor-a');
    b = await createTenantFixture(owner, 'anchor-b');
    await owner.tenantSetting.create({
      data: { tenantId: b, key: AUDIT_ANCHOR_STATUS_SETTING_KEY, value: future },
    });
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a, b]);
  });

  const run = (tenantId: string) => processors.get('audit-anchor')!({ data: { tenantId } });

  it('speichert den Status LOCAL_ONLY wie bisher, ohne Owner-Zugriff', async () => {
    resetOwnerAccess();
    await run(a);

    const stored = await owner.tenantSetting.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: a, key: AUDIT_ANCHOR_STATUS_SETTING_KEY } },
      select: { value: true },
    });
    expect(stored.value).toMatchObject({
      state: 'LOCAL_ONLY',
      lastSuccessAt: null,
      consecutiveFailures: 0,
      error: 'keine externe RFC-3161-TSA konfiguriert',
    });
    expect(ownerAccess.denied).toEqual([]);
    expect(ownerAccess.allowed).toEqual([]);
  });

  it('lässt einen neueren Status nicht von einem älteren Versuch überschreiben', async () => {
    resetOwnerAccess();
    // Tenant B trägt einen Status mit späterem Versuchszeitpunkt.
    await run(b);
    expect(
      (
        await owner.tenantSetting.findUniqueOrThrow({
          where: { tenantId_key: { tenantId: b, key: AUDIT_ANCHOR_STATUS_SETTING_KEY } },
          select: { value: true },
        })
      ).value,
    ).toEqual(future);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keinen Status von Tenant B', async () => {
    expect(
      await withSystemContext(a, (tx) => tx.tenantSetting.findMany({ where: { tenantId: b } })),
    ).toEqual([]);
  });
});
