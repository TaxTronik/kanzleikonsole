// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001, GWG-RETENTION-DESTRUCTION-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): gwg-expiry-check über die App-Rolle.
//
// Admin/Partner, Kandidaten, Stufe 3 (Check EXPIRED, Mandant deaktiviert,
// Audit, Widerrufsmarker), Portal-Widerruf, Hinweise, Ausweis-Erinnerung mit
// Auto-Anforderung und die Lösch-Queue der strukturierten Aufzeichnungen laufen
// im SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Beim Owner-Client
// bleiben nur die tenantübergreifende Liste offener Widerrufsmarker und die
// Belegzählung der Lösch-Queue; jeder andere Owner-Zugriff ließe die Suite
// scheitern. Belegt: dieselben Statuswechsel, Audit-Ereignisse, Hinweise und
// Anforderungen wie zuvor, und die ablaufende Prüfung eines fremden Tenants
// bleibt unsichtbar und unverändert.
//
// Redis (Portal-Widerruf) ist eine Attrappe. Nur mit ausdrücklichem Opt-in im
// db-Job (WORKER_DB_TEST=1). Die Tenants behalten ihre append-only Audit-Zeilen
// und GwG-Prüfungen in der Wegwerf-Datenbank.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createActiveClientFixture,
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

const redis = vi.hoisted(() => ({ revoked: [] as string[] }));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({
  connection: {
    eval: async (_script: string, _keys: number, key: string) => {
      redis.revoked.push(key);
      return 'OK';
    },
  },
}));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return {
    ...actual,
    prismaOwner: guardOwnerClient(actual.prismaOwner, ['client.findMany', 'document.count']),
  };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { processors } from './mocks/bullmq';
import '../gwg-expiry-check';

const describeDb = enabled ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('S-01 gwg-expiry-check via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', admin: '', hb: '', stage1: '', stage3: '', contact: '', idDoc: '' };
  const checks = { stage1: '', stage3: '' };
  const b = { tenant: '', admin: '', client: '', check: '' };

  async function verifiedCheckOf(clientId: string): Promise<string> {
    return (await owner.gwgCheck.findFirstOrThrow({ where: { clientId }, select: { id: true } }))
      .id;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    const now = Date.now();
    a.tenant = await createTenantFixture(owner, 'gwg-expiry-a');
    a.admin = await createStaffFixture(owner, a.tenant, { name: 'gwg-a-admin', role: 'ADMIN' });
    a.hb = await createStaffFixture(owner, a.tenant, { name: 'gwg-a-hb' });
    // Stufe 1: Prüfung in 60 Tagen fällig, Ausweis in 30 Tagen.
    a.stage1 = await createActiveClientFixture(owner, a.tenant, a.admin, 'gwg-a-stage1', {
      validUntil: new Date(now + 60 * DAY_MS),
      idExpiryDate: new Date(now + 30 * DAY_MS),
    });
    // Stufe 3: Prüfung läuft in Sekunden ab (Aktivierung verlangt eine gültige Prüfung).
    const stage3ValidUntil = new Date(now + 1_500);
    a.stage3 = await createActiveClientFixture(owner, a.tenant, a.admin, 'gwg-a-stage3', {
      validUntil: stage3ValidUntil,
    });
    await owner.clientResponsibility.createMany({
      data: [a.stage1, a.stage3].map((clientId) => ({
        tenantId: a.tenant,
        clientId,
        staffId: a.hb,
        role: 'HAUPTBEARBEITER' as const,
      })),
    });
    a.contact = (
      await owner.clientContact.create({
        data: {
          tenantId: a.tenant,
          clientId: a.stage3,
          email: `gwg-contact-${a.stage3}@example.test`,
          fullName: 'Synthetic contact',
        },
        select: { id: true },
      })
    ).id;
    checks.stage1 = await verifiedCheckOf(a.stage1);
    checks.stage3 = await verifiedCheckOf(a.stage3);
    a.idDoc = (
      await owner.gwgIdDocument.findFirstOrThrow({
        where: { gwgCheckId: checks.stage1 },
        select: { id: true },
      })
    ).id;

    b.tenant = await createTenantFixture(owner, 'gwg-expiry-b');
    b.admin = await createStaffFixture(owner, b.tenant, { name: 'gwg-b-admin', role: 'ADMIN' });
    b.client = await createActiveClientFixture(owner, b.tenant, b.admin, 'gwg-b', {
      validUntil: new Date(now + 60 * DAY_MS),
    });
    b.check = await verifiedCheckOf(b.client);

    // Bis zum Lauf ist die Stufe-3-Prüfung abgelaufen.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, stage3ValidUntil.getTime() - Date.now() + 200)),
    );
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('eskaliert, deaktiviert und erinnert wie bisher, ohne Owner-Zugriff auf Mandantendaten', async () => {
    resetOwnerAccess();
    const result = await processors.get('gwg-expiry-check')!({ data: { tenantId: a.tenant } });

    expect(result).toEqual({
      stage1: 1,
      stage2: 0,
      stage3: 2,
      idDocReminders: 1,
      idDocRequests: 1,
      deletionDueNotices: 0,
    });
    // Stufe 3: Prüfung EXPIRED, Mandant deaktiviert, Marker nach Widerruf gelöscht.
    expect(
      await owner.gwgCheck.findUniqueOrThrow({
        where: { id: checks.stage3 },
        select: { status: true },
      }),
    ).toEqual({ status: 'EXPIRED' });
    expect(
      await owner.client.findUniqueOrThrow({
        where: { id: a.stage3 },
        select: { allowActive: true, portalSessionRevocationPendingAt: true },
      }),
    ).toEqual({ allowActive: false, portalSessionRevocationPendingAt: null });
    expect(redis.revoked).toEqual([`revoke:portal:${a.contact}`]);
    const audit = await owner.auditLog.findMany({
      where: { tenantId: a.tenant, actorType: 'SYSTEM' },
      select: { action: true, resourceId: true },
      orderBy: { id: 'asc' },
    });
    expect(audit).toEqual([
      { action: 'gwg.check.expire', resourceId: checks.stage3 },
      { action: 'client.deactivate.gwg_expired', resourceId: a.stage3 },
    ]);
    // Stufe 1 bleibt VERIFIED; Hinweise je Stufe und Ausweis.
    expect(
      await owner.gwgCheck.findUniqueOrThrow({
        where: { id: checks.stage1 },
        select: { status: true },
      }),
    ).toEqual({ status: 'VERIFIED' });
    const notes = await owner.notification.findMany({
      where: { tenantId: a.tenant },
      select: { staffId: true, kind: true, resourceId: true },
    });
    expect(notes.map((note) => `${note.kind}|${note.staffId}|${note.resourceId}`).sort()).toEqual(
      [
        `GWG_EXPIRED|${a.admin}|${checks.stage3}`,
        `GWG_EXPIRED|${a.hb}|${checks.stage3}`,
        `GWG_EXPIRY_90D|${a.hb}|${checks.stage1}`,
        `GWG_ID_EXPIRY_SOON|${a.hb}|${a.idDoc}`,
      ].sort(),
    );
    // Auto-Anforderung an den aktiven Mandanten, angelegt durch Admin/Partner.
    expect(
      await owner.request.findMany({
        where: { tenantId: a.tenant },
        select: { clientId: true, createdByStaff: true, linkedGwgIdDocumentId: true },
      }),
    ).toEqual([{ clientId: a.stage1, createdByStaff: a.admin, linkedGwgIdDocumentId: a.idDoc }]);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)].sort()).toEqual(['client.findMany', 'document.count']);
  });

  it('lässt die ablaufende Prüfung eines fremden Tenants unsichtbar und unverändert', async () => {
    expect(await owner.notification.count({ where: { tenantId: b.tenant } })).toBe(0);
    expect(
      await owner.gwgCheck.findUniqueOrThrow({ where: { id: b.check }, select: { status: true } }),
    ).toEqual({ status: 'VERIFIED' });
    expect(
      await withSystemContext(a.tenant, (tx) => tx.gwgCheck.findMany({ where: { id: b.check } })),
    ).toEqual([]);
  });
});
