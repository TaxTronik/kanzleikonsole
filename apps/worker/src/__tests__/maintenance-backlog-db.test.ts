// Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001, ACCESS-TENANT-RLS-001
// =============================================================================
// B14 / S-01: Alarmhinweise des Wartungsrückstands über die App-Rolle.
//
// recordMaintenanceBacklog liest die aktiven ADMIN/PARTNER einer betroffenen
// Kanzlei, schreibt deren Rückstandshinweis und schließt offene Hinweise
// nicht mehr betroffener Kanzleien im SYSTEM-Kontext des Tenants über
// taxtronik_app (RLS). Beim Owner-Client bleibt nur die mandantenübergreifende
// Liste der Kanzleien mit offenem Hinweis; sie ist hier auf die Fixture-Tenants
// begrenzt. Redis ist eine Attrappe im Speicher, OPS_ALERT_EMAIL ist leer (der
// Mailweg prüft maintenance-backlog.test.ts). Belegt: Hinweis nur an die
// aktiven ADMIN/PARTNER der betroffenen Kanzlei, Abschluss im nächsten Lauf
// ohne Rückstand, kein weiterer Owner-Zugriff, und im Kontext von Tenant A
// bleiben die Hinweise von Tenant B unsichtbar.
//
// Nur mit ausdrücklichem Opt-in (WORKER_DB_TEST=1, im db-CI-Job DB_TESTS=1).
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

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    tenants: [] as string[],
    store,
    redis: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      },
      del: async (key: string) => (store.delete(key) ? 1 : 0),
    },
  };
});

vi.mock('../queues', () => ({ connection: h.redis }));
vi.mock('../env', () => ({ env: { OPS_ALERT_EMAIL: undefined } }));
vi.mock('../mailer', () => ({ sendOpsMail: vi.fn(async () => true) }));
vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('./app-role-db');
  return {
    ...actual,
    prismaOwner: guardOwnerClient(actual.prismaOwner, ['notification.findMany'], {
      // Mandantenübergreifende Liste wie im Job, begrenzt auf die Fixture-Tenants.
      'notification.findMany': (args: unknown) => {
        const query = args as { where: Record<string, unknown> };
        return actual.prismaOwner.notification.findMany({
          ...(query as object),
          where: { ...query.where, tenantId: { in: h.tenants } },
        } as Parameters<typeof actual.prismaOwner.notification.findMany>[0]);
      },
    }),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { recordMaintenanceBacklog } from '../maintenance-backlog';

const describeDb = enabled ? describe : describe.skip;
const NOW = new Date('2026-10-07T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const KIND = 'SYSTEM_AUDIT_ARCHIVE_BACKLOG' as const;

describeDb('B14 maintenance backlog alarm via the app role', () => {
  let owner: Owner;
  let a = '';
  let b = '';
  let adminA = '';
  let partnerA = '';
  let inactiveAdminA = '';
  let employeeA = '';
  let foreignNotice = '';

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    a = await createTenantFixture(owner, 'backlog-a');
    b = await createTenantFixture(owner, 'backlog-b');
    adminA = await createStaffFixture(owner, a, { name: 'admin-a', role: 'ADMIN' });
    partnerA = await createStaffFixture(owner, a, { name: 'partner-a', role: 'PARTNER' });
    inactiveAdminA = await createStaffFixture(owner, a, {
      name: 'inactive-a',
      role: 'ADMIN',
      active: false,
    });
    employeeA = await createStaffFixture(owner, a, { name: 'employee-a' });
    const adminB = await createStaffFixture(owner, b, { name: 'admin-b', role: 'ADMIN' });
    // Offener Hinweis in Tenant B, dessen Rückstand weiter besteht: bleibt offen.
    foreignNotice = (
      await owner.notification.create({
        data: {
          tenantId: b,
          staffId: adminB,
          kind: KIND,
          title: 'Wartungsrückstand: Audit-Archivierung',
          body: 'fremd',
          resourceType: 'tenant',
          resourceId: b,
        },
        select: { id: true },
      })
    ).id;
    h.tenants = [a, b];
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a, b]);
  });

  it('meldet den Rückstand nur den aktiven ADMIN/PARTNER der Kanzlei und schließt ihn wieder', async () => {
    resetOwnerAccess();
    h.store.clear();
    const status = await recordMaintenanceBacklog(
      'auditRotate',
      [
        { tenantId: a, count: 4, oldestDueAt: new Date(NOW.getTime() - 9 * DAY) },
        { tenantId: b, count: 2, oldestDueAt: new Date(NOW.getTime() - 9 * DAY) },
      ],
      NOW,
    );
    expect(status).toMatchObject({ count: 6, consecutiveRuns: 1, alarm: true });

    const noticesA = await owner.notification.findMany({
      where: { tenantId: a, kind: KIND },
      select: { staffId: true, body: true, resourceId: true, readAt: true },
      orderBy: { staffId: 'asc' },
    });
    expect(noticesA.map((notice) => notice.staffId).sort()).toEqual([adminA, partnerA].sort());
    expect(noticesA.map((notice) => notice.staffId)).not.toContain(inactiveAdminA);
    expect(noticesA.map((notice) => notice.staffId)).not.toContain(employeeA);
    for (const notice of noticesA) {
      expect(notice).toMatchObject({ resourceId: a, readAt: null });
      expect(notice.body).toContain('4 (ältester fällig seit 9 Tagen)');
    }

    // Nächster Lauf: Kanzlei A ohne Rückstand, Kanzlei B weiter betroffen.
    const next = await recordMaintenanceBacklog(
      'auditRotate',
      [{ tenantId: b, count: 2, oldestDueAt: new Date(NOW.getTime() - 9 * DAY) }],
      new Date(NOW.getTime() + 60 * 60 * 1000),
    );
    expect(next).toMatchObject({ count: 2, consecutiveRuns: 2, alarm: true });
    const after = await owner.notification.findMany({
      where: { tenantId: a, kind: KIND },
      select: { readAt: true },
    });
    expect(after).toHaveLength(2);
    expect(after.every((notice) => notice.readAt !== null)).toBe(true);
    const foreign = await owner.notification.findUniqueOrThrow({
      where: { id: foreignNotice },
      select: { readAt: true },
    });
    expect(foreign.readAt).toBeNull();

    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)]).toEqual(['notification.findMany']);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Hinweise von Tenant B', async () => {
    expect(
      await withSystemContext(a, (tx) =>
        tx.notification.findMany({ where: { tenantId: b, kind: KIND } }),
      ),
    ).toEqual([]);
  });
});
