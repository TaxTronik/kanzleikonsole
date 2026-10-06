// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// R-02: gemeinsamer Session-Widerruf (S11) für Web und Worker — monoton per
// Lua-Skript und fail-closed. Die Reihenfolge gegen ein echtes Redis prüft
// apps/web/src/server/auth/__tests__/revocation.redis.test.ts (opt-in).
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import {
  advanceSessionRevocation,
  isIssuedBeforeRevocation,
  readSessionRevocationTimestamp,
  SESSION_REVOCATION_TTL_SEC,
  SessionRevocationUnavailableError,
  sessionRevocationKey,
  type SessionRevocationRedis,
} from '../session-revocation';

function redis(overrides: Partial<SessionRevocationRedis> = {}): SessionRevocationRedis {
  return { eval: vi.fn(async () => 'OK'), get: vi.fn(async () => null), ...overrides };
}

describe('advanceSessionRevocation', () => {
  it('schreibt den Cutoff atomar per Lua-Skript mit 30 Tagen TTL', async () => {
    const client = redis();

    await advanceSessionRevocation(client, 'portal', 'contact-1', 1_780_000_000_123);

    expect(SESSION_REVOCATION_TTL_SEC).toBe(30 * 24 * 60 * 60);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'revoke:portal:contact-1',
      '1780000000123',
      SESSION_REVOCATION_TTL_SEC,
    );
    const script = vi.mocked(client.eval).mock.calls[0]![0];
    // Monoton: ein jüngerer gespeicherter Cutoff wird nur verlängert, nie überschrieben.
    expect(script).toContain('if current > incoming then');
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[2])");
    // Fail-closed: unlesbare gespeicherte oder eingehende Werte sind ein Fehler.
    expect(script).toContain('invalid existing revocation timestamp');
    expect(script).toContain('invalid incoming revocation timestamp');
  });

  it('bestätigt ohne Redis-Client keinen Widerruf', async () => {
    await expect(advanceSessionRevocation(null, 'staff', 'staff-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
  });

  it('meldet Redis-Fehler und unerwartete Antworten als nicht verfügbar (mit Ursache)', async () => {
    const failure = new Error('READONLY replica');
    await expect(
      advanceSessionRevocation(
        redis({ eval: vi.fn(async () => Promise.reject(failure)) }),
        'portal',
        'c',
      ),
    ).rejects.toMatchObject({ name: 'SessionRevocationUnavailableError', cause: failure });
    await expect(
      advanceSessionRevocation(redis({ eval: vi.fn(async () => 'QUEUED') }), 'portal', 'c'),
    ).rejects.toBeInstanceOf(SessionRevocationUnavailableError);
  });
});

describe('readSessionRevocationTimestamp', () => {
  it('liefert 0 ohne Widerruf und den gespeicherten Cutoff', async () => {
    await expect(readSessionRevocationTimestamp(redis(), 'staff', 's')).resolves.toBe(0);
    const client = redis({ get: vi.fn(async () => '1780000000123') });
    await expect(readSessionRevocationTimestamp(client, 'staff', 's')).resolves.toBe(
      1_780_000_000_123,
    );
    expect(client.get).toHaveBeenCalledWith(sessionRevocationKey('staff', 's'));
  });

  it.each(['abc', '-5', '0', '1.5', '9007199254740993'])(
    'behandelt den unlesbaren Wert %s fail-closed',
    async (stored) => {
      await expect(
        readSessionRevocationTimestamp(redis({ get: vi.fn(async () => stored) }), 'staff', 's'),
      ).rejects.toBeInstanceOf(SessionRevocationUnavailableError);
    },
  );

  it('bricht ohne Redis-Client oder bei Lesefehlern ab', async () => {
    await expect(readSessionRevocationTimestamp(undefined, 'portal', 'c')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
    await expect(
      readSessionRevocationTimestamp(
        redis({ get: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) }),
        'portal',
        'c',
      ),
    ).rejects.toBeInstanceOf(SessionRevocationUnavailableError);
  });
});

describe('isIssuedBeforeRevocation', () => {
  const cutoffMs = 1_780_000_000_500;

  it('lässt ohne Cutoff jedes Token gelten', () => {
    expect(isIssuedBeforeRevocation(0, 1_780_000_000)).toBe(false);
    expect(isIssuedBeforeRevocation(0, undefined)).toBe(false);
  });

  it('widerruft die gesamte Cutoff-Sekunde und alles davor', () => {
    expect(isIssuedBeforeRevocation(cutoffMs, 1_779_999_999)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, 1_780_000_000)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, 1_780_000_001)).toBe(false);
  });

  it('lässt ein Token ohne belastbares iat einen Cutoff nicht umgehen', () => {
    expect(isIssuedBeforeRevocation(cutoffMs, undefined)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, Number.NaN)).toBe(true);
  });
});
