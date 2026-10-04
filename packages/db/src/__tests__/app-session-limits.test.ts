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
