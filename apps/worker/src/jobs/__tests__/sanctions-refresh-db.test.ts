// Fachkatalog: GWG-SCREENING-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): sanctions-refresh über die App-Rolle.
//
// Modulschalter, Quellenstand, Snapshot, Folgeläufe, Audit und Hinweise laufen
// im SYSTEM-Kontext des Tenants über taxtronik_app (RLS); die Screening-Policies
// lassen den SYSTEM-Akteur zu (Folgeläufe mit created_by NULL). Beim
// Owner-Client bleibt nur die Tenant-Liste. Der EU-Abruf ist eine Attrappe.
// Belegt: derselbe Snapshot, derselbe Folgelauf mit Namenskandidat, dieselben
// Audit-Ereignisse und Hinweise wie zuvor, und der Ursprungslauf eines fremden
// Tenants bleibt unsichtbar und ohne Folgelauf.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen und unveränderlichen Prüfläufe in der
// Wegwerf-Datenbank.
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

const enabled = process.env['WORKER_DB_TEST'] === '1';
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const SUBJECT = 'Synthetic Sanktionsperson';

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/tax/screening/source', () => ({
  fetchEuSanctions: async () => ({
    sha256: 'c'.repeat(64),
    sourceUrl: 'https://example.test/synthetic-eu-list',
    sourceVersion: 'synthetic-s01',
    publishedAt: new Date('2026-08-05'),
    entries: [
      {
        id: 'synthetic-s01',
        euReference: 'synthetic-EU-S01',
        type: 'person',
        names: [{ name: 'Synthetic Sanktionsperson', strong: true }],
        birthDates: [],
        countries: [],
        regulations: [],
      },
    ],
  }),
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, ['tenant.findMany']) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { runSanctionsRefresh } from '../sanctions-refresh';

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 sanctions-refresh via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', admin: '', client: '', root: '' };
  const b = { tenant: '', admin: '', client: '', root: '' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    for (const [fixture, label] of [
      [a, 'sanctions-a'],
      [b, 'sanctions-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.admin = await createStaffFixture(owner, fixture.tenant, {
        name: `${label}-admin`,
        role: 'ADMIN',
      });
      fixture.client = await createClientFixture(owner, fixture.tenant, label);
      await owner.tenantSetting.create({
        data: { tenantId: fixture.tenant, key: 'modules', value: { sanctionsScreening: true } },
      });
      // EU-Ursprungslauf gegen einen älteren Listenstand.
      const initial = await owner.sanctionsSnapshot.create({
        data: {
          tenantId: fixture.tenant,
          sha256: 'b'.repeat(64),
          sourceUrl: 'https://example.test/synthetic-eu-list',
          sourceVersion: 'synthetic-initial',
          publishedAt: new Date('2026-08-01'),
          entries: [],
          entryCount: 1,
        },
        select: { id: true },
      });
      fixture.root = (
        await owner.screeningRun.create({
          data: {
            tenantId: fixture.tenant,
            clientId: fixture.client,
            kind: 'EU',
            snapshotId: initial.id,
            subject: { name: SUBJECT, role: 'Mandant' },
            result: { status: 'NO_CANDIDATES' },
            createdBy: fixture.admin,
          },
          select: { id: true },
        })
      ).id;
    }
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('übernimmt die Liste und legt den Folgelauf an wie bisher, ohne Owner-Zugriff auf Mandantendaten', async () => {
    resetOwnerAccess();
    expect(await runSanctionsRefresh(a.tenant)).toEqual({ tenants: 1, runs: 1, failed: 0 });

    const snapshots = await owner.sanctionsSnapshot.findMany({
      where: { tenantId: a.tenant, sha256: 'c'.repeat(64) },
      select: { id: true },
    });
    expect(snapshots).toHaveLength(1);
    expect(
      await owner.sanctionsSourceState.findUniqueOrThrow({
        where: { tenantId: a.tenant },
        select: { lastError: true },
      }),
    ).toEqual({ lastError: null });
    const followups = await owner.screeningRun.findMany({
      where: { tenantId: a.tenant, previousRunId: a.root },
      select: { id: true, snapshotId: true, createdBy: true, clientId: true },
    });
    expect(followups).toEqual([
      { id: expect.any(String), snapshotId: snapshots[0]!.id, createdBy: null, clientId: a.client },
    ]);
    const audit = await owner.auditLog.findMany({
      where: { tenantId: a.tenant },
      select: { action: true, actorType: true, resourceId: true },
      orderBy: { id: 'asc' },
    });
    expect(audit).toEqual([
      { action: 'screening.source.refresh', actorType: 'SYSTEM', resourceId: snapshots[0]!.id },
      { action: 'screening.run.followup', actorType: 'SYSTEM', resourceId: followups[0]!.id },
    ]);
    const notes = await owner.notification.findMany({
      where: { tenantId: a.tenant },
      select: { staffId: true, kind: true, clientId: true },
    });
    expect(notes).toEqual([{ staffId: a.admin, kind: 'SCREENING_REVIEW', clientId: a.client }]);
    expect(ownerAccess.denied).toEqual([]);
    expect([...new Set(ownerAccess.allowed)]).toEqual(['tenant.findMany']);
  });

  it('lässt den Ursprungslauf eines fremden Tenants unsichtbar und ohne Folgelauf', async () => {
    expect(await owner.screeningRun.count({ where: { tenantId: b.tenant } })).toBe(1);
    expect(
      await owner.sanctionsSnapshot.count({
        where: { tenantId: b.tenant, sha256: 'c'.repeat(64) },
      }),
    ).toBe(0);
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.screeningRun.findMany({ where: { id: b.root } }),
      ),
    ).toEqual([]);
  });
});
