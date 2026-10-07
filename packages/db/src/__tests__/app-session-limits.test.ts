// Fachkatalog: ACCESS-TENANT-RLS-001 (Rolle taxtronik_app)
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { APP_SESSION_LIMITS, createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { TX_OPTIONS } from '../tenant-context';

describe('Serverseitige Grenzen des App-Clients', () => {
  it('liegen über dem Transaktionslimit und ändern damit kein heute gelingendes Ergebnis', () => {
    expect(APP_SESSION_LIMITS.statementTimeoutMs).toBeGreaterThan(TX_OPTIONS.timeout);
    expect(APP_SESSION_LIMITS.idleInTransactionSessionTimeoutMs).toBeGreaterThan(
      TX_OPTIONS.timeout,
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Session-Limit-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const appUrl = optionalDatabaseUrl(process.env['DATABASE_APP_URL']);
const limited = new PrismaClient({ adapter: createPostgresAdapter(appUrl, APP_SESSION_LIMITS) });
const unlimited = new PrismaClient({ adapter: createPostgresAdapter(appUrl) });
const tiny = new PrismaClient({
  adapter: createPostgresAdapter(appUrl, { statementTimeoutMs: 200 }),
});

afterAll(async () => {
  await Promise.all([limited.$disconnect(), unlimited.$disconnect(), tiny.$disconnect()]);
});

async function settings(client: typeof limited) {
  const rows = await client.$queryRaw<Array<{ statement: string; idle: string }>>`
    SELECT current_setting('statement_timeout') AS statement,
           current_setting('idle_in_transaction_session_timeout') AS idle
  `;
  return rows[0];
}

describeWithDatabase('Serverseitige Grenzen gegen PostgreSQL', () => {
  it('setzt die Grenzen auf jeder Verbindung des App-Clients', async () => {
    await expect(settings(limited)).resolves.toEqual({ statement: '20s', idle: '30s' });
  });

  it('lässt Verbindungen ohne ausdrückliche Grenzen unverändert', async () => {
    await expect(settings(unlimited)).resolves.toEqual({ statement: '0', idle: '0' });
  });

  it('bricht eine zu lange Abfrage in der Datenbank selbst ab', async () => {
    await expect(tiny.$queryRaw`SELECT pg_sleep(2)`).rejects.toThrow(/57014|statement timeout/i);
  });
});

// F-06: lock_timeout ist eine Datenbankeinstellung der App-Rolle (Migration
// 20261007140000_app_role_lock_timeout), keine Pool-Option: sie gilt auch für
// Verbindungen ohne APP_SESSION_LIMITS, nicht aber für die Owner-Rolle.
const LOCK_KEY = 4_630_360_014; // beliebiger, testeigener Advisory-Lock-Schlüssel

async function withConnection<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function lockTimeoutMs(client: Client): Promise<number> {
  const { rows } = await client.query<{ ms: string }>(
    "SELECT (EXTRACT(epoch FROM current_setting('lock_timeout')::interval) * 1000)::bigint AS ms",
  );
  return Number(rows[0]!.ms);
}

describeWithDatabase('lock_timeout der App-Rolle (F-06)', () => {
  const ownerUrl = optionalDatabaseUrl(process.env['DATABASE_URL']);

  it('gilt für jede neue Verbindung der App-Rolle, auch ohne Pool-Grenzen', async () => {
    const freshApp = await withConnection(appUrl, lockTimeoutMs);
    const [pool] = await limited.$queryRaw<Array<{ lock: string }>>`
      SELECT current_setting('lock_timeout') AS lock
    `;

    expect(freshApp).toBe(5_000);
    expect(pool?.lock).toBe('5s');
    // Warten auf eine Sperre endet vor Transaktions- und Statement-Timeout und
    // nicht später als das Warten auf eine Pool-Verbindung.
    expect(freshApp).toBeLessThanOrEqual(TX_OPTIONS.maxWait);
    expect(freshApp).toBeLessThan(TX_OPTIONS.timeout);
    expect(freshApp).toBeLessThan(APP_SESSION_LIMITS.statementTimeoutMs);
  });

  it('lässt die Owner-Rolle für lange Wartungsjobs ohne lock_timeout', async () => {
    await expect(withConnection(ownerUrl, lockTimeoutMs)).resolves.toBe(0);
  });

  it('bricht das Warten der App-Rolle auf eine Sperre mit 55P03 ab', async () => {
    await withConnection(ownerUrl, async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const started = Date.now();
        await withConnection(appUrl, async (waiter) => {
          await expect(
            waiter.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]),
          ).rejects.toMatchObject({ code: '55P03' });
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      } finally {
        await holder.query('ROLLBACK');
      }
    });
  }, 20_000);
});
