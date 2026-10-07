// Fachkatalog: AUDIT-RFC3161-ANCHOR-001
// =============================================================================
// P-05: Rolling-Anchor-Takt gegen echtes PostgreSQL.
//
// Belegt: (1) je Tenant höchstens ein Stempel je Mindestabstand, offene
// Rechnungs- und GwG-Einträge (einschließlich GwG-bedingter Mandanten-
// änderungen und StBVV-Rechnungsentwürfen) sofort und bevorzugt, TSA-Backoff
// bleibt wirksam; (2) während des TSA-Aufrufs hält der Lauf nur den
// committeten Tenant-Lease, aber weder Transaktion noch Verbindung; ein
// paralleler Lauf fragt die TSA nicht erneut an; ein abgelaufener Lease wird
// übernommen.
//
// Fixtures entstehen in zurückgerollten Owner-Transaktionen; nur der
// Verbindungstest committet und räumt seinen Tenant am Ende vollständig ab.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import { IMMEDIATE_ANCHOR_ACTIONS, tenantsDueForAnchoring } from '../anchor-schedule';
import {
  anchorLatestWithLease,
  claimAnchorLease,
  type SettledAnchorAttempt,
} from '../anchor-lease';
import { ANCHOR_LEASE_EXPIRED_REASON, EvidenceService } from '../service';
import type { TimestampPort, TimestampResult } from '../ports/timestamp';

// Wie verify-checkpoint-db.test.ts: nur mit ausdrücklichem Opt-in im db-Job.
// S-01: DATABASE_URL ist dort die Owner-Rolle der Container; nur das Abräumen
// committeter Audit-/Anker-Zeilen braucht den Tabellen-Owner
// (EVIDENCE_DB_ADMIN_URL, sonst DATABASE_URL).
// B-02: lokal per EVIDENCE_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['EVIDENCE_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'EVIDENCE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'EVIDENCE_DB_ADMIN_URL']) {
    if (name === 'EVIDENCE_DB_ADMIN_URL' && !process.env[name]) continue;
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`EVIDENCE_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`EVIDENCE_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

type Tx = Prisma.TransactionClient;

function sha256(b: Uint8Array | string): Buffer {
  return createHash('sha256').update(b).digest();
}

/** TSA-Attrappe, deren Antwort bis zur Freigabe zurückgehalten werden kann. */
class GatedTsa implements TimestampPort {
  readonly mode = 'rfc3161' as const;
  calls = 0;
  private release: () => void = () => undefined;
  private gate: Promise<void> = Promise.resolve();
  entered: Promise<void> = Promise.resolve();
  private signalEntered: () => void = () => undefined;

  hold(): void {
    this.gate = new Promise((resolve) => (this.release = resolve));
    this.entered = new Promise((resolve) => (this.signalEntered = resolve));
  }
  open(): void {
    this.release();
  }
  async timestamp(payload: Uint8Array): Promise<TimestampResult> {
    this.calls++;
    this.signalEntered();
    await this.gate;
    return {
      timestampedAt: new Date().toISOString(),
      tsaRequestBlob: Buffer.from('request'),
      tsaResponseBlob: sha256(payload),
      tsaSerial: String(this.calls),
    };
  }
  async verify(payload: Uint8Array, response: Uint8Array | null): Promise<boolean> {
    return !!response && sha256(payload).equals(Buffer.from(response));
  }
  async verifyDetailed(payload: Uint8Array, response: Uint8Array | null) {
    const ok = await this.verify(payload, response);
    return { ok, trustAnchored: ok };
  }
}

const ROLLBACK = new Error('rollback');
const MIN_INTERVAL_MS = 60_000;

(enabled ? describe : describe.skip)('P-05: Rolling-Anchor-Takt (PostgreSQL)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  // Nur zum Abräumen committeter Audit-/Anker-Zeilen (Schutz-Trigger aus).
  const admin = process.env['EVIDENCE_DB_ADMIN_URL']
    ? new PrismaClient({
        adapter: createPostgresAdapter(process.env['EVIDENCE_DB_ADMIN_URL']),
      })
    : owner;
  let lockTenant: string;

  beforeAll(async () => {
    lockTenant = (
      await owner.tenant.create({
        data: { slug: `anchor-lock-${randomUUID()}`, name: 'Anchor-Sperre' },
      })
    ).id;
  });

  afterAll(async () => {
    // Alle Audit-/Anker-Zeilen wurden zurückgerollt; der Tenant ist leer.
    await owner.tenant.delete({ where: { id: lockTenant } });
    await owner.$disconnect();
    if (admin !== owner) await admin.$disconnect();
  });

  /** Führt eine Owner-Transaktion aus und rollt sie zurück; liefert das Zwischenergebnis. */
  async function inRollback<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    let value!: T;
    await expect(
      owner.$transaction(
        async (tx) => {
          value = await work(tx);
          throw ROLLBACK;
        },
        { timeout: 60_000, maxWait: 10_000 },
      ),
    ).rejects.toBe(ROLLBACK);
    return value;
  }

  async function tenant(tx: Tx, label: string): Promise<string> {
    return (await tx.tenant.create({ data: { slug: `${label}-${randomUUID()}`, name: label } })).id;
  }

  /**
   * Audit-Zeilen ohne Kettenlogik: der Takt liest nur IDs, Aktionen und
   * Zeitpunkte (clock_timestamp, damit die Reihenfolge in einer Transaktion steigt).
   */
  async function entries(tx: Tx, tenantId: string, actions: string[]): Promise<void> {
    for (const action of actions) {
      await tx.$executeRaw`
        INSERT INTO audit_log (
          tenant_id, occurred_at, actor_type, action, resource_type, prev_hash, this_hash
        ) VALUES (
          ${tenantId}::uuid, clock_timestamp(), 'SYSTEM', ${action}, 'test',
          ${sha256(randomUUID())}, ${sha256(randomUUID())}
        )
      `;
    }
  }

  /** Anker über alle bisherigen Einträge des Tenants, angelegt vor `secondsAgo` Sekunden. */
  async function anchorAll(tx: Tx, tenantId: string, secondsAgo: number): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO audit_anchor (
        tenant_id, from_audit_id, top_audit_id, top_hash, previous_anchor_hash, anchor_hash,
        tsa_request_blob, tsa_response_blob, tsa_serial, tsa_gen_time, trust_anchored, created_at
      )
      SELECT ${tenantId}::uuid, min(id), max(id),
             (SELECT this_hash FROM audit_log WHERE tenant_id = ${tenantId}::uuid
               ORDER BY id DESC LIMIT 1),
             ${sha256(randomUUID())}, ${sha256(randomUUID())},
             '\\x00', '\\x00', NULL, now(), true,
             now() - ${secondsAgo}::int * interval '1 second'
      FROM audit_log WHERE tenant_id = ${tenantId}::uuid
    `;
  }

  async function backoff(tx: Tx, tenantId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO tenant_setting (tenant_id, key, value, updated_at)
      VALUES (${tenantId}::uuid, 'audit_anchor_status',
              jsonb_build_object('nextRetryAt', (now() + interval '5 minutes')::text), now())
    `;
  }

  async function leaseHolders(tenantId: string): Promise<Array<{ holder: string }>> {
    return owner.$queryRaw<Array<{ holder: string }>>`
      SELECT holder::text AS holder FROM audit_anchor_lease WHERE tenant_id = ${tenantId}::uuid
    `;
  }

  it('stempelt je Tenant höchstens einmal je Mindestabstand, Rechnung/GwG sofort und zuerst', async () => {
    const { due, ids } = await inRollback(async (tx) => {
      const ids = {
        fresh: await tenant(tx, 'anchor-fresh'),
        recent: await tenant(tx, 'anchor-recent'),
        recentInvoice: await tenant(tx, 'anchor-invoice'),
        recentGwg: await tenant(tx, 'anchor-gwg'),
        gwgClient: await tenant(tx, 'anchor-gwg-client'),
        gwgExpired: await tenant(tx, 'anchor-gwg-expired'),
        stbvvInvoice: await tenant(tx, 'anchor-stbvv-invoice'),
        lookalike: await tenant(tx, 'anchor-lookalike'),
        old: await tenant(tx, 'anchor-old'),
        settled: await tenant(tx, 'anchor-settled'),
        backoff: await tenant(tx, 'anchor-backoff'),
      };
      // Ältester offener Eintrag zuerst: "old" vor "fresh".
      await entries(tx, ids.old, ['client.update']);
      await anchorAll(tx, ids.old, 120);
      await entries(tx, ids.old, ['client.update']);
      for (const id of [
        ids.recent,
        ids.recentInvoice,
        ids.recentGwg,
        ids.gwgClient,
        ids.gwgExpired,
        ids.stbvvInvoice,
        ids.lookalike,
        ids.settled,
      ]) {
        await entries(tx, id, ['client.update']);
        await anchorAll(tx, id, 5);
      }
      await entries(tx, ids.recent, ['document.upload', 'client.update']);
      await entries(tx, ids.recentInvoice, ['client.update', 'invoice.send']);
      await entries(tx, ids.recentGwg, ['gwg.check.verify']);
      await entries(tx, ids.gwgClient, ['client.update.gwg_relevant']);
      await entries(tx, ids.gwgExpired, ['client.deactivate.gwg_expired']);
      await entries(tx, ids.stbvvInvoice, ['stbvv.invoice.draft']);
      await entries(tx, ids.lookalike, ['client.update.gwgXrelevant', 'stbvv.quote.create']);
      await entries(tx, ids.fresh, ['request.response']);
      await entries(tx, ids.backoff, ['invoice.create']);
      await backoff(tx, ids.backoff);

      const due = await tenantsDueForAnchoring(tx, {
        minIntervalMs: MIN_INTERVAL_MS,
        limit: 100_000,
      });
      return { due, ids };
    });

    const mine = due.filter((id) => Object.values(ids).includes(id));
    expect(new Set(mine.slice(0, 5))).toEqual(
      new Set([ids.recentInvoice, ids.recentGwg, ids.gwgClient, ids.gwgExpired, ids.stbvvInvoice]),
    );
    expect(mine.slice(5)).toEqual([ids.old, ids.fresh]);
    expect(IMMEDIATE_ANCHOR_ACTIONS.exact).toContain('client.update.gwg_relevant');
  });

  it('wartet ohne Rechnung/GwG bis der Mindestabstand abgelaufen ist', async () => {
    const due = await inRollback(async (tx) => {
      const before = await tenant(tx, 'anchor-before');
      const after = await tenant(tx, 'anchor-after');
      for (const [id, secondsAgo] of [
        [before, 59],
        [after, 61],
      ] as const) {
        await entries(tx, id, ['client.update']);
        await anchorAll(tx, id, secondsAgo);
        await entries(tx, id, ['client.update']);
      }
      const result = await tenantsDueForAnchoring(tx, {
        minIntervalMs: MIN_INTERVAL_MS,
        limit: 100_000,
      });
      return { result, before, after };
    });
    expect(due.result).toContain(due.after);
    expect(due.result).not.toContain(due.before);
  });

  it('hält während des TSA-Aufrufs nur den Lease, keine Transaktion oder Verbindung', async () => {
    const url = optionalDatabaseUrl(process.env['DATABASE_URL']);
    const previousLimit = process.env['DATABASE_CONNECTION_LIMIT'];
    process.env['DATABASE_CONNECTION_LIMIT'] = '1';
    const single = new PrismaClient({ adapter: createPostgresAdapter(url) });
    if (previousLimit === undefined) delete process.env['DATABASE_CONNECTION_LIMIT'];
    else process.env['DATABASE_CONNECTION_LIMIT'] = previousLimit;
    const tsa = new GatedTsa();
    const service = new EvidenceService(tsa);
    const leaseTenant = (
      await owner.tenant.create({ data: { slug: `anchor-lease-${randomUUID()}`, name: 'Lease' } })
    ).id;
    try {
      await entries(owner as unknown as Tx, leaseTenant, ['client.update', 'invoice.send']);
      tsa.hold();
      const settled: SettledAnchorAttempt[] = [];
      const first = anchorLatestWithLease(
        service,
        single,
        leaseTenant,
        { requireTrustAnchor: true },
        async (attempt) => {
          // settle läuft noch unter dem Lease.
          expect(await leaseHolders(leaseTenant)).toHaveLength(1);
          settled.push(attempt);
        },
      );
      await tsa.entered;

      // Die einzige Pool-Verbindung ist während des TSA-Aufrufs frei.
      await expect(single.$queryRaw`SELECT 1::int AS one`).resolves.toEqual([{ one: 1 }]);
      // Der Lease ist committet: ein paralleler Lauf fragt die TSA nicht an.
      expect(await anchorLatestWithLease(service, owner, leaseTenant)).toEqual({
        status: 'locked',
      });
      expect(tsa.calls).toBe(1);

      tsa.open();
      expect(await first).toMatchObject({
        status: 'done',
        result: { anchored: true, trustAnchored: true },
      });
      expect(settled).toHaveLength(1);
      expect(await leaseHolders(leaseTenant)).toEqual([]);
    } finally {
      tsa.open();
      await single.$disconnect();
      await admin.$transaction(async (tx) => {
        for (const [table, trigger] of [
          ['audit_anchor', 'audit_anchor_no_modify'],
          ['audit_log', 'audit_log_no_modify'],
        ]) {
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = '${leaseTenant}'`);
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
        await tx.tenant.delete({ where: { id: leaseTenant } });
      });
    }
  });

  it('verwirft das Token, wenn der Lease während der TSA-Anfrage abläuft und übernommen wird', async () => {
    const slow = new GatedTsa();
    const expiredTenant = (
      await owner.tenant.create({
        data: { slug: `anchor-expired-${randomUUID()}`, name: 'Lease abgelaufen' },
      })
    ).id;
    try {
      await entries(owner as unknown as Tx, expiredTenant, ['invoice.send']);
      slow.hold();
      const first = anchorLatestWithLease(new EvidenceService(slow), owner, expiredTenant, {
        leaseTtlMs: 300,
      });
      await slow.entered;
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Der Lease ist abgelaufen: ein zweiter Lauf übernimmt und verankert.
      expect(
        await anchorLatestWithLease(new EvidenceService(new GatedTsa()), owner, expiredTenant),
      ).toMatchObject({ status: 'done', result: { anchored: true } });

      slow.open();
      expect(await first).toEqual({
        status: 'done',
        result: { anchored: false, reason: ANCHOR_LEASE_EXPIRED_REASON },
      });
      const anchors = await owner.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM audit_anchor WHERE tenant_id = ${expiredTenant}::uuid
      `;
      expect(anchors).toEqual([{ n: 1 }]);
    } finally {
      slow.open();
      await admin.$transaction(async (tx) => {
        for (const [table, trigger] of [
          ['audit_anchor', 'audit_anchor_no_modify'],
          ['audit_log', 'audit_log_no_modify'],
        ]) {
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = '${expiredTenant}'`);
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
        }
        await tx.tenant.delete({ where: { id: expiredTenant } });
      });
    }
  });

  it('übernimmt nur einen abgelaufenen Lease und gibt nur den eigenen frei', async () => {
    await inRollback(async (tx) => {
      const first = await claimAnchorLease(tx, lockTenant, 60_000);
      expect(first).not.toBeNull();
      expect(await claimAnchorLease(tx, lockTenant, 60_000)).toBeNull();
      await tx.$executeRaw`
        UPDATE audit_anchor_lease
        SET acquired_at = clock_timestamp() - interval '10 minutes',
            expires_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = ${lockTenant}::uuid
      `;
      // Abgelaufen: Der alte Halter darf nicht mehr fragen, ein neuer übernimmt.
      expect(await first!.confirm()).toBe(false);
      const second = await claimAnchorLease(tx, lockTenant, 60_000);
      expect(second).not.toBeNull();
      await first!.release();
      expect(await second!.confirm()).toBe(true);
      await second!.release();
      expect(await claimAnchorLease(tx, lockTenant, 60_000)).not.toBeNull();
    });
  });

  it('wertet Datenbankfehler nicht als TSA-Fehler', async () => {
    const tsa = new GatedTsa();
    const failing = {
      $queryRaw: async () => {
        throw new Error('Unable to start a transaction in the given time.');
      },
      $queryRawUnsafe: async () => [],
      $executeRaw: async () => 0,
    } as unknown as Tx;
    const attempt = await anchorLatestWithLease(new EvidenceService(tsa), failing, lockTenant);
    expect(attempt).toMatchObject({ status: 'failed' });
    expect(tsa.calls).toBe(0);
  });
});
