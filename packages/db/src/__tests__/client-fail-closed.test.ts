// =============================================================================
// Fail-closed RLS-Backstop des App-DB-Clients (reiner Logik-Test, kein Postgres)
//
// Sicherheitsinvariant: Der App-Client (Request-Pfad) darf NIEMALS still auf die
// Owner-Verbindung (DATABASE_URL, BYPASSRLS) zurückfallen. Sonst läge jede
// Tenant-Query ohne RLS-Filter offen → Cross-Tenant-Leak, § 203 StGB.
//
// Dieser Bug existierte real (buildClient() fiel auf DATABASE_URL zurück) und
// wäre von den RLS-Integrationstests NICHT gefangen worden, weil die ihre
// Clients selbst konstruieren. Daher dieser deterministische Guard.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { resolveAppDatasourceUrl } from '../client';

const APP_URL = 'postgresql://taxtronik_app:pw@db:5432/taxtronik?schema=public';
const OWNER_URL = 'postgresql://taxtronik:pw@db:5432/taxtronik?schema=public';

describe('resolveAppDatasourceUrl — fail-closed RLS-Backstop', () => {
  it('Produktion ohne DATABASE_APP_URL: wirft (kein Owner-Fallback)', () => {
    expect(() =>
      resolveAppDatasourceUrl({ NODE_ENV: 'production', DATABASE_URL: OWNER_URL }),
    ).toThrow(/DATABASE_APP_URL/);
  });

  it('Produktion ohne beide URLs: wirft ebenfalls', () => {
    expect(() => resolveAppDatasourceUrl({ NODE_ENV: 'production' })).toThrow(/DATABASE_APP_URL/);
  });

  it('Produktion mit DATABASE_APP_URL: nutzt die App-URL, NIE die Owner-URL', () => {
    const url = resolveAppDatasourceUrl({
      NODE_ENV: 'production',
      DATABASE_APP_URL: APP_URL,
      DATABASE_URL: OWNER_URL,
    });
    expect(url).toBe(APP_URL);
    expect(url).not.toBe(OWNER_URL);
  });

  it('Entwicklung ohne DATABASE_APP_URL: Owner-Fallback erlaubt (lokaler Komfort)', () => {
    const url = resolveAppDatasourceUrl({ NODE_ENV: 'development', DATABASE_URL: OWNER_URL });
    expect(url).toBe(OWNER_URL);
  });

  it('Test/CI ohne DATABASE_APP_URL: kein Wurf, Fallback auf vorhandene URL', () => {
    expect(() => resolveAppDatasourceUrl({ NODE_ENV: 'test', DATABASE_URL: OWNER_URL })).not.toThrow();
  });

  it('Ohne NODE_ENV (undefined): kein Production-Zwang', () => {
    const url = resolveAppDatasourceUrl({ DATABASE_APP_URL: APP_URL });
    expect(url).toBe(APP_URL);
  });

  it('Bevorzugt immer DATABASE_APP_URL vor DATABASE_URL', () => {
    const url = resolveAppDatasourceUrl({
      NODE_ENV: 'development',
      DATABASE_APP_URL: APP_URL,
      DATABASE_URL: OWNER_URL,
    });
    expect(url).toBe(APP_URL);
  });
});
