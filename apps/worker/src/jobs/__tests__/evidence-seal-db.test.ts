// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): evidence-seal über die App-Rolle.
//
// Offene Tage, Tagesspitze und Siegel liest und schreibt der Job je Tenant im
// SYSTEM-Kontext über taxtronik_app (RLS; die App-Rolle darf audit_seal lesen
// und anlegen). Außerhalb von Produktion fällt die TSA-Auswahl hier auf den
// lokalen Zeitstempel zurück. Belegt mit dem manuellen Tageslauf: dasselbe
// Siegel wie bisher (Tagesspitze, sealed_by system), ein zweiter Lauf bleibt
// idempotent, kein Owner-Zugriff, und Siegel und Audit-Einträge eines fremden
// Tenants bleiben unberührt und im Kontext von Tenant A unsichtbar.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen in der Wegwerf-Datenbank.
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
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { processors } from './mocks/bullmq';
import '../evidence-seal';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 evidence-seal via the app role', () => {
  let owner: Owner;
  let a = '';
  let b = '';
  const today = new Date().toISOString().slice(0, 10);

  async function auditEntry(tenantId: string) {
    await withSystemContext(tenantId, (tx) =>
      new EvidenceService(new LocalTimestampAdapter()).record(tx, {
        tenantId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 's01.seal.fixture',
        resourceType: 'tenant',
        resourceId: tenantId,
        after: {},
      }),
    );
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a = await createTenantFixture(owner, 'seal-a');
    b = await createTenantFixture(owner, 'seal-b');
    await auditEntry(a);
    await auditEntry(a);
    await auditEntry(b);
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a, b]);
  });

  const run = (tenantId: string) =>
    processors.get('evidence-seal')!({ data: { tenantId, sealDate: today } });

  it('versiegelt die Tagesspitze wie bisher und bleibt idempotent, ohne Owner-Zugriff', async () => {
    resetOwnerAccess();
    await expect(run(a)).resolves.toEqual({ sealed: [{ tenantId: a, sealed: true }] });
    await expect(run(a)).resolves.toEqual({
      sealed: [{ tenantId: a, sealed: false, reason: 'bereits versiegelt' }],
    });

    const top = await owner.auditLog.findFirstOrThrow({
      where: { tenantId: a },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const seals = await owner.$queryRaw<
      Array<{ seal_date: string; top_audit_id: bigint; sealed_by: string }>
    >`
      SELECT seal_date::text AS seal_date, top_audit_id, sealed_by
        FROM audit_seal WHERE tenant_id = ${a}::uuid`;
    expect(seals).toEqual([{ seal_date: today, top_audit_id: top.id, sealed_by: 'system' }]);
    expect(ownerAccess.denied).toEqual([]);
    expect(ownerAccess.allowed).toEqual([]);
  });

  it('lässt Siegel und Einträge eines fremden Tenants unberührt und unsichtbar', async () => {
    expect(
      await owner.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM audit_seal WHERE tenant_id = ${b}::uuid`,
    ).toEqual([{ count: 0n }]);
    expect(
      await withSystemContext(a, async (tx) => ({
        audit: await tx.auditLog.count({ where: { tenantId: b } }),
        seals: await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*)::bigint AS count FROM audit_seal WHERE tenant_id = ${b}::uuid`,
      })),
    ).toEqual({ audit: 0, seals: [{ count: 0n }] });
  });
});
