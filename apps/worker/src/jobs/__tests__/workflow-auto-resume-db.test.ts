// Fachkatalog: WORKFLOW-LIFECYCLE-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): workflow-auto-resume über die App-Rolle.
//
// Die mandantenübergreifende Kandidatensuche (nur ID und Tenant) bleibt beim
// Owner-Client; jede Instanz wird danach im SYSTEM-Kontext ihres Tenants über
// taxtronik_app (RLS) fortgesetzt und auditiert. In dieser Suite lässt der
// Owner-Client nur diese Suche zu. Belegt: dieselben Instanzen wie zuvor
// (fällig und Modul aktiv), jede im Kontext und in der Audit-Kette ihres
// eigenen Tenants, und im Kontext von Tenant A ist die Instanz von Tenant B
// unsichtbar.
//
// Ein Stichtag im Jahr 2000 begrenzt den Lauf auf die Instanzen dieser Suite.
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Tenants mit
// append-only Audit-Zeilen bleiben in der Wegwerf-Datenbank.
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
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return {
    ...actual,
    prismaOwner: guardOwnerClient(actual.prismaOwner, ['workflowInstance.findMany']),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { runWorkflowAutoResume } from '../workflow-auto-resume';

const describeDb = enabled ? describe : describe.skip;
const PAUSED_UNTIL = new Date('2000-01-01T00:00:00.000Z');
const NOW = new Date('2000-01-02T00:00:00.000Z');

describeDb('S-01 workflow-auto-resume via the app role', () => {
  let owner: Owner;
  const tenants = { a: '', b: '', off: '' };
  const instances = { aDue: '', aLater: '', bDue: '', offDue: '' };

  async function pausedInstance(tenantId: string, pausedUntil: Date): Promise<string> {
    const staff = await createStaffFixture(owner, tenantId, { name: `wf-${tenantId}` });
    const client = await createClientFixture(owner, tenantId, `wf-${tenantId}`);
    const instance = await owner.workflowInstance.create({
      data: {
        tenantId,
        clientId: client,
        name: 'Synthetic workflow',
        status: 'PAUSED',
        pausedUntil,
        startedByStaff: staff,
      },
      select: { id: true },
    });
    return instance.id;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    tenants.a = await createTenantFixture(owner, 'wf-resume-a');
    tenants.b = await createTenantFixture(owner, 'wf-resume-b');
    tenants.off = await createTenantFixture(owner, 'wf-resume-off');
    await owner.tenantSetting.create({
      data: { tenantId: tenants.off, key: 'modules', value: { workflows: false } },
    });
    instances.aDue = await pausedInstance(tenants.a, PAUSED_UNTIL);
    instances.aLater = await pausedInstance(tenants.a, new Date('2000-02-01T00:00:00.000Z'));
    instances.bDue = await pausedInstance(tenants.b, PAUSED_UNTIL);
    instances.offDue = await pausedInstance(tenants.off, PAUSED_UNTIL);
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [tenants.a, tenants.b, tenants.off]);
  });

  it('setzt dieselben Instanzen fort wie bisher, jede im Kontext ihres Tenants', async () => {
    resetOwnerAccess();
    const result = await runWorkflowAutoResume(NOW);

    expect(result).toEqual({ due: 3, resumed: 2, unchanged: 0, moduleDisabled: 1, failed: 0 });
    const rows = await owner.workflowInstance.findMany({
      where: { id: { in: Object.values(instances) } },
      select: { id: true, tenantId: true, status: true, pausedUntil: true, completedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [instances.aDue, instances.bDue]) {
      const row = byId.get(id)!;
      expect(row.status).not.toBe('PAUSED');
      expect(row.pausedUntil).toBeNull();
      // Audit in der Kette des eigenen Tenants, mit dem tatsächlichen Endstatus.
      const audit = await owner.auditLog.findMany({
        where: { tenantId: row.tenantId, action: 'workflow.instance.auto_resume' },
        select: { actorType: true, resourceId: true, after: true },
      });
      expect(audit).toEqual([
        {
          actorType: 'SYSTEM',
          resourceId: id,
          after: { status: row.status, completedAt: row.completedAt?.toISOString() ?? null },
        },
      ]);
    }
    // Noch nicht fällig bzw. Workflow-Modul aus: unverändert pausiert.
    expect(byId.get(instances.aLater)!.status).toBe('PAUSED');
    expect(byId.get(instances.offDue)!.status).toBe('PAUSED');
    expect(await owner.auditLog.count({ where: { tenantId: tenants.off } })).toBe(0);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)]).toEqual(['workflowInstance.findMany']);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A die Instanz von Tenant B nicht', async () => {
    expect(
      await withSystemContext(tenants.a, (tx) =>
        tx.workflowInstance.findMany({ where: { id: instances.bDue } }),
      ),
    ).toEqual([]);
    expect(await owner.workflowInstance.count({ where: { id: instances.bDue } })).toBe(1);
  });
});
