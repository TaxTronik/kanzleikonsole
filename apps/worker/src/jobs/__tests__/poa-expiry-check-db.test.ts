// Fachkatalog: POA-LIFECYCLE-001, ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): poa-expiry-check über die App-Rolle.
//
// Kandidatensuche, Ablauf SIGNED → EXPIRED mit Audit, Auflösung der
// Vorwarnung und die Hinweise laufen im SYSTEM-Kontext des Tenants über
// taxtronik_app (RLS). Der Owner-Client ist in dieser Suite gesperrt. Belegt:
// dieselben Vollmachten wie zuvor (abgelaufen erst am Folgetag, Warnung im
// 30-Tage-Fenster, sonst nichts) und eine abgelaufene Vollmacht eines fremden
// Tenants bleibt unsichtbar und unverändert.
//
// Die Vollmachten durchlaufen wie in poa-signing-integrity.test.ts den
// kontrollierten Weg DRAFT → SENT (Versand-Snapshot) → SIGNED.
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Die Tenants
// behalten ihre append-only Audit-Zeilen in der Wegwerf-Datenbank.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
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
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { processors } from './mocks/bullmq';
import { berlinTodayUtcMidnight } from '../../date-util';
import '../poa-expiry-check';

const describeDb = enabled ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

describeDb('S-01 poa-expiry-check via the app role', () => {
  let owner: Owner;
  const today = berlinTodayUtcMidnight(new Date());
  const a = { tenant: '', hb: '', client: '', expired: '', soon: '', later: '' };
  const b = { tenant: '', hb: '', client: '', expired: '' };

  /** DRAFT → SENT mit gültigem Versand-Snapshot → SIGNED, wie die Integritäts-Suite. */
  async function signedPoa(
    tenantId: string,
    clientId: string,
    staffId: string,
    validUntil: Date,
  ): Promise<string> {
    const validFrom = new Date(Date.UTC(2026, 0, 1));
    const draft = await owner.powerOfAttorney.create({
      data: {
        tenantId,
        clientId,
        signerEmail: `signer-${randomUUID()}@example.test`,
        signerName: 'Sina Signer',
        subject: `Vollmacht ${isoDate(validUntil)}`,
        scope: 'Vertretung gegenüber dem Finanzamt',
        validFrom,
        validUntil,
        status: 'DRAFT',
        createdByStaff: staffId,
      },
    });
    const serialized = JSON.stringify({
      schemaVersion: 1,
      subject: draft.subject,
      signerName: draft.signerName,
      signerEmail: draft.signerEmail,
      validFrom: isoDate(validFrom),
      validUntil: isoDate(validUntil),
      scope: draft.scope,
      document: null,
    });
    const sha256 = createHash('sha256').update(serialized, 'utf8').digest();
    const sent = await owner.powerOfAttorney.update({
      where: { id: draft.id },
      data: {
        status: 'SENT',
        signingTokenHash: `token-${draft.id}`,
        signingTokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
        signingContentSnapshot: serialized,
        signingContentSha256: sha256,
      },
    });
    await owner.powerOfAttorney.update({
      where: { id: draft.id },
      data: {
        status: 'SIGNED',
        signedAt: new Date(sent.sentAt!.getTime() + 1_000),
        signedContentSha256: sha256,
      },
    });
    return draft.id;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    for (const [fixture, label] of [
      [a, 'poa-expiry-a'],
      [b, 'poa-expiry-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.hb = await createStaffFixture(owner, fixture.tenant, { name: label });
      fixture.client = await createClientFixture(owner, fixture.tenant, label);
      await owner.clientResponsibility.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          staffId: fixture.hb,
          role: 'HAUPTBEARBEITER',
        },
      });
      // Gültig bis gestern: ab heute abgelaufen.
      fixture.expired = await signedPoa(
        fixture.tenant,
        fixture.client,
        fixture.hb,
        new Date(today.getTime() - DAY_MS),
      );
    }
    a.soon = await signedPoa(a.tenant, a.client, a.hb, new Date(today.getTime() + 10 * DAY_MS));
    a.later = await signedPoa(a.tenant, a.client, a.hb, new Date(today.getTime() + 60 * DAY_MS));
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  it('lässt dieselben Vollmachten ablaufen und warnt wie bisher, ohne den Owner-Client', async () => {
    resetOwnerAccess();
    const result = await processors.get('poa-expiry-check')!({ data: { tenantId: a.tenant } });

    expect(result).toEqual({ soon: 1, expired: 1 });
    const statuses = await owner.powerOfAttorney.findMany({
      where: { tenantId: a.tenant },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [a.expired]: 'EXPIRED',
      [a.soon]: 'SIGNED',
      [a.later]: 'SIGNED',
    });
    const notes = await owner.notification.findMany({
      where: { tenantId: a.tenant },
      select: { staffId: true, kind: true, resourceId: true },
    });
    expect(notes.sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
      { staffId: a.hb, kind: 'POA_EXPIRED', resourceId: a.expired },
      { staffId: a.hb, kind: 'POA_EXPIRY_SOON', resourceId: a.soon },
    ]);
    const audit = await owner.auditLog.findMany({
      where: { tenantId: a.tenant, action: 'poa.expire' },
      select: { actorType: true, resourceId: true },
    });
    expect(audit).toEqual([{ actorType: 'SYSTEM', resourceId: a.expired }]);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('lässt die abgelaufene Vollmacht eines fremden Tenants unsichtbar und unverändert', async () => {
    expect(
      await owner.powerOfAttorney.findUniqueOrThrow({
        where: { id: b.expired },
        select: { status: true },
      }),
    ).toEqual({ status: 'SIGNED' });
    expect(await owner.notification.count({ where: { tenantId: b.tenant } })).toBe(0);
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.powerOfAttorney.findMany({ where: { id: b.expired } }),
      ),
    ).toEqual([]);
  });
});
