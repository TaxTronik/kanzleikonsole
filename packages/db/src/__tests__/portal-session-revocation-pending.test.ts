// =============================================================================
// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// B7: Marker für ausstehende Portal-Session-Widerrufe gegen PostgreSQL
// (Migration 20261007100300, src/portal-session-revocation.ts). Der Worker
// gwg-expiry-check setzt den Marker in der Transaktion, die den Mandanten
// deaktiviert, und löscht ihn nach bestätigtem Widerruf per Compare-and-Set.
// Die Ablaufsteuerung (Fehlschlag, Wiederholung, Nachholen vor allen anderen
// Schritten) prüfen die Worker-Unit-Tests in
// apps/worker/src/jobs/__tests__/gwg-expiry-check.test.ts.
//
// Die Transaktionen laufen wie im Worker als S-01-Owner-Rolle taxtronik_owner
// mit gesetztem Tenant-Kontext (withWorkerTenantContext).
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import {
  clearPortalSessionRevocationPendingTx,
  listPendingPortalSessionRevocations,
  markPortalSessionRevocationPendingTx,
  type PendingPortalSessionRevocation,
} from '../portal-session-revocation';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Test der Portal-Session-Widerrufsmarker braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const db = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

describeWithDatabase('B7: Marker für ausstehende Portal-Session-Widerrufe', () => {
  const tenantIds: string[] = [];
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const stamp = Date.now();
    for (const suffix of ['a', 'b']) {
      const tenant = await db.tenant.create({
        data: { slug: `test-b7-${suffix}-${stamp}`, name: `B7-Widerrufsmarker ${suffix}` },
      });
      tenantIds.push(tenant.id);
    }
    [tenantA, tenantB] = tenantIds as [string, string];
  });

  afterAll(async () => {
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await db.$disconnect();
  });

  /** Wie withWorkerTenantContext, ausdrücklich als Owner-Rolle des Workers. */
  function asWorker<T>(tenantId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_owner');
      await tx.$queryRaw`
        SELECT
          set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_actor_id', '', true),
          set_config('app.current_actor_type', 'SYSTEM', true)
      `;
      return work(tx);
    });
  }

  function mark(tenantId: string, clientId: string): Promise<PendingPortalSessionRevocation> {
    return asWorker(tenantId, (tx) =>
      markPortalSessionRevocationPendingTx(tx, { tenantId, clientId }),
    );
  }

  async function makeClient(tenantId: string, name: string): Promise<string> {
    const client = await db.client.create({ data: { tenantId, kind: 'NATPERS', name } });
    return client.id;
  }

  function stored(clientId: string) {
    return db.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { name: true, portalSessionRevocationPendingAt: true, updatedAt: true },
    });
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('setzt den Marker in der Transaktion und lässt updated_at unverändert', async () => {
    const clientId = await makeClient(tenantA, 'B7 Marker');
    const before = await stored(clientId);

    const pending = await mark(tenantA, clientId);

    const after = await stored(clientId);
    expect(pending.pendingAt).toBeInstanceOf(Date);
    expect(pending).toEqual({
      tenantId: tenantA,
      clientId,
      pendingAt: after.portalSessionRevocationPendingAt,
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('ohne Marker committet die Transaktion nicht: Rollback und fremder Tenant', async () => {
    const clientId = await makeClient(tenantA, 'B7 Rollback');

    // Bricht die Transaktion nach dem Setzen ab, verschwindet der Marker mit ihr.
    await expect(
      asWorker(tenantA, async (tx) => {
        await tx.client.update({ where: { id: clientId }, data: { name: 'B7 geändert' } });
        await markPortalSessionRevocationPendingTx(tx, { tenantId: tenantA, clientId });
        throw new Error('Abbruch nach dem Setzen');
      }),
    ).rejects.toThrow('Abbruch nach dem Setzen');
    expect(await stored(clientId)).toMatchObject({
      name: 'B7 Rollback',
      portalSessionRevocationPendingAt: null,
    });

    // Passt der Tenant nicht, wirft das Setzen und nimmt die übrigen
    // Schreibzugriffe der Transaktion (hier stellvertretend der Name) mit.
    await expect(
      asWorker(tenantB, async (tx) => {
        await tx.client.update({ where: { id: clientId }, data: { name: 'B7 geändert' } });
        await markPortalSessionRevocationPendingTx(tx, { tenantId: tenantB, clientId });
      }),
    ).rejects.toThrow(/Portal-Session-Widerruf: Mandant .* nicht gefunden/);
    expect(await stored(clientId)).toMatchObject({
      name: 'B7 Rollback',
      portalSessionRevocationPendingAt: null,
    });
  });

  it('listet offene Marker je Tenant oder tenantübergreifend, älteste zuerst', async () => {
    const first = await makeClient(tenantA, 'B7 Liste 1');
    const second = await makeClient(tenantA, 'B7 Liste 2');
    const foreign = await makeClient(tenantB, 'B7 Liste fremd');
    const untouched = await makeClient(tenantA, 'B7 ohne Marker');
    const mine = new Set([first, second, foreign, untouched]);

    const marks: PendingPortalSessionRevocation[] = [];
    for (const [tenantId, clientId] of [
      [tenantA, second],
      [tenantB, foreign],
      [tenantA, first],
    ] as const) {
      marks.push(await mark(tenantId, clientId));
      await pause(5);
    }
    const [secondMark, foreignMark, firstMark] = marks;

    const ofTenantA = (await listPendingPortalSessionRevocations(db, tenantA)).filter((p) =>
      mine.has(p.clientId),
    );
    expect(ofTenantA).toEqual([secondMark, firstMark]);

    const all = await listPendingPortalSessionRevocations(db);
    expect(all.filter((p) => mine.has(p.clientId))).toEqual([secondMark, foreignMark, firstMark]);
    const times = all.map((p) => p.pendingAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('löscht per Compare-and-Set nur den gelesenen Marker, unabhängig von der Zeitzone', async () => {
    const clientId = await makeClient(tenantA, 'B7 CAS');
    const earlier = await mark(tenantA, clientId);
    await pause(5);
    // Erneute Deaktivierung, bevor der ältere Widerruf als erledigt galt.
    const latest = await mark(tenantA, clientId);
    expect(latest.pendingAt.getTime()).toBeGreaterThan(earlier.pendingAt.getTime());
    const before = await stored(clientId);

    // Ein Widerruf, der den älteren Stand gelesen hat, löscht den neuen nicht.
    expect(
      await asWorker(tenantA, (tx) => clearPortalSessionRevocationPendingTx(tx, earlier)),
    ).toBe(false);
    // Ein anderer Tenant trifft die Zeile nicht.
    expect(
      await asWorker(tenantB, (tx) =>
        clearPortalSessionRevocationPendingTx(tx, { ...latest, tenantId: tenantB }),
      ),
    ).toBe(false);
    expect((await stored(clientId)).portalSessionRevocationPendingAt).toEqual(latest.pendingAt);

    // Der Nachholpfad liest den Marker über Prisma und löscht genau diesen
    // Wert, auch wenn die Sitzung eine andere Zeitzone verwendet.
    const [listed] = (await listPendingPortalSessionRevocations(db, tenantA)).filter(
      (p) => p.clientId === clientId,
    );
    expect(listed).toEqual(latest);
    expect(
      await asWorker(tenantA, async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
        return clearPortalSessionRevocationPendingTx(tx, listed!);
      }),
    ).toBe(true);
    const after = await stored(clientId);
    expect(after.portalSessionRevocationPendingAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await asWorker(tenantA, (tx) => clearPortalSessionRevocationPendingTx(tx, latest))).toBe(
      false,
    );
  });
});
