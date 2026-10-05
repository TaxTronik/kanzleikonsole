// P-06: App- und Owner-Pool werden je Dienst getrennt bemessen; das frühere
// DATABASE_CONNECTION_LIMIT bleibt nur Fallback.
import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_MAX, POOL_MAX_ENV, resolvePoolMax } from '../prisma-adapter';

describe('resolvePoolMax', () => {
  it('nutzt ohne Konfiguration die dokumentierten Defaults (= bisheriger pg-Default 10)', () => {
    expect(resolvePoolMax('app', {})).toBe(DEFAULT_POOL_MAX.app);
    expect(resolvePoolMax('owner', {})).toBe(DEFAULT_POOL_MAX.owner);
    expect(DEFAULT_POOL_MAX).toEqual({ app: 10, owner: 10 });
  });

  it('bemisst App- und Owner-Pool getrennt über die Pool-Variablen', () => {
    const env = { DATABASE_APP_POOL_MAX: '20', DATABASE_OWNER_POOL_MAX: '5' };
    expect(POOL_MAX_ENV).toEqual({
      app: 'DATABASE_APP_POOL_MAX',
      owner: 'DATABASE_OWNER_POOL_MAX',
    });
    expect(resolvePoolMax('app', env)).toBe(20);
    expect(resolvePoolMax('owner', env)).toBe(5);
  });

  it('fällt nur ohne Pool-Variable auf DATABASE_CONNECTION_LIMIT zurück', () => {
    const env = { DATABASE_CONNECTION_LIMIT: '7', DATABASE_OWNER_POOL_MAX: '3' };
    expect(resolvePoolMax('app', env)).toBe(7);
    expect(resolvePoolMax('owner', env)).toBe(3);
    // Clients ohne Rolle (Seeds, Restore-Probes) verhalten sich wie bisher.
    expect(resolvePoolMax(undefined, env)).toBe(7);
    expect(resolvePoolMax(undefined, {})).toBeUndefined();
  });

  it('ignoriert leere und ungültige Werte', () => {
    for (const raw of ['', '0', '-3', '2.5', 'zehn', '20abc']) {
      expect(resolvePoolMax('app', { DATABASE_APP_POOL_MAX: raw }), raw).toBe(10);
    }
    expect(resolvePoolMax('app', { DATABASE_APP_POOL_MAX: ' 12 ' })).toBe(12);
  });
});
