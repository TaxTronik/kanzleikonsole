// Fachkatalog: ACCESS-TENANT-RLS-001
// =============================================================================
// R-02: gemeinsamer Session-Widerruf (S11) für Web und Worker — monoton per
// Lua-Skript und fail-closed. Die Reihenfolge gegen ein echtes Redis prüft
// apps/web/src/server/auth/__tests__/revocation.redis.test.ts (opt-in).
// =============================================================================

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ADVANCE_REVOCATION,
  advanceGlobalSessionRevocation,
  advanceSessionRevocation,
  GLOBAL_SESSION_REVOCATION_KEY,
  isIssuedBeforeRevocation,
  readSessionRevocationTimestamp,
  readSessionRevocationState,
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

    await advanceSessionRevocation(client, 'portal', 'contact-1');

    expect(SESSION_REVOCATION_TTL_SEC).toBe(30 * 24 * 60 * 60);
    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'revoke:portal:contact-1',
      SESSION_REVOCATION_TTL_SEC,
    );
    const script = vi.mocked(client.eval).mock.calls[0]![0];
    // Monoton: ein jüngerer gespeicherter Cutoff wird nur verlängert, nie überschrieben.
    expect(script).toContain('if current > incoming then');
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])");
    // Eingehende Uhrzeit aus Redis, gespeicherte Werte werden validiert.
    expect(script).toContain('invalid existing revocation timestamp');
    expect(script).toContain("redis.call('TIME')");
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

describe('advanceGlobalSessionRevocation', () => {
  it('setzt revoke:all mit demselben monotonen Skript und 30 Tagen TTL', async () => {
    const client = redis();

    await advanceGlobalSessionRevocation(client);

    expect(GLOBAL_SESSION_REVOCATION_KEY).toBe('revoke:all');
    expect(client.eval).toHaveBeenCalledWith(
      ADVANCE_REVOCATION,
      1,
      'revoke:all',
      SESSION_REVOCATION_TTL_SEC,
    );
  });

  it('bestätigt ohne Redis oder bei unerwarteter Antwort keinen Widerruf', async () => {
    await expect(advanceGlobalSessionRevocation(null)).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
    await expect(
      advanceGlobalSessionRevocation(redis({ eval: vi.fn(async () => 'QUEUED') })),
    ).rejects.toBeInstanceOf(SessionRevocationUnavailableError);
  });

  it('das Betreiberkommando führt wörtlich dasselbe Skript für revoke:all aus', () => {
    // CVP-Nachprüfung 20.11.2026, Befund 2: ./taxtronik revoke-all-sessions
    // schreibt den Stichtag per redis-cli EVAL im Redis-Container.
    const ops = readFileSync(
      new URL('../../../../scripts/ops/sessions.sh', import.meta.url),
      'utf8',
    );
    const lua = /<<'LUA'\n([\s\S]*?)\nLUA\n/.exec(ops)?.[1];
    expect(lua?.trim()).toBe(ADVANCE_REVOCATION.trim());
    expect(ops).toContain(GLOBAL_SESSION_REVOCATION_KEY);
    expect(ops).toContain(String(SESSION_REVOCATION_TTL_SEC));
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
    expect(client.get).toHaveBeenCalledWith(GLOBAL_SESSION_REVOCATION_KEY);
  });

  it('liefert den späteren aus persönlichem und globalem Stichtag', async () => {
    const stored: Record<string, string | null> = {
      'revoke:staff:s': '1780000000123',
      'revoke:all': '1780000005000',
    };
    const client = redis({ get: vi.fn(async (key: string) => stored[key] ?? null) });
    await expect(readSessionRevocationTimestamp(client, 'staff', 's')).resolves.toBe(
      1_780_000_005_000,
    );
    stored['revoke:all'] = null;
    await expect(readSessionRevocationTimestamp(client, 'staff', 's')).resolves.toBe(
      1_780_000_000_123,
    );
    stored['revoke:staff:s'] = null;
    stored['revoke:all'] = '1780000005000';
    await expect(readSessionRevocationTimestamp(client, 'staff', 's')).resolves.toBe(
      1_780_000_005_000,
    );
    // Ein unlesbarer globaler Wert sperrt fail-closed.
    stored['revoke:all'] = 'kaputt';
    await expect(readSessionRevocationTimestamp(client, 'staff', 's')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
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

  it('widerruft bei Bestands-Tokens die gesamte Cutoff-Sekunde und alles davor', () => {
    expect(isIssuedBeforeRevocation(cutoffMs, 1_779_999_999)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, 1_780_000_000)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, 1_780_000_001)).toBe(false);
  });

  it('unterscheidet Neuanmeldungen nach dem Widerruf in derselben Sekunde (ACCESS-TENANT-RLS-001)', () => {
    const sec = Math.floor(cutoffMs / 1000);
    expect(isIssuedBeforeRevocation(cutoffMs, sec, cutoffMs - 1)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, sec, cutoffMs)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, sec, cutoffMs + 1)).toBe(false);
    expect(isIssuedBeforeRevocation(cutoffMs, sec, cutoffMs + 1000)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, sec, Number.NaN)).toBe(true);
    expect(isIssuedBeforeRevocation(0, sec, cutoffMs + 1000)).toBe(true);
    expect(isIssuedBeforeRevocation(0, sec, Number.NaN)).toBe(true);
  });

  it('lässt ein Token ohne belastbares iat einen Cutoff nicht umgehen', () => {
    expect(isIssuedBeforeRevocation(cutoffMs, undefined)).toBe(true);
    expect(isIssuedBeforeRevocation(cutoffMs, Number.NaN)).toBe(true);
  });
});

describe('readSessionRevocationState', () => {
  it('liest Zeit, persönlichen und globalen Cutoff atomar', async () => {
    const now = 1_780_000_000_700;
    for (const [personal, global, expected] of [
      [0, 0, 0],
      [now - 100, 0, now - 100],
      [0, now - 50, now - 50],
      [now - 100, now - 50, now - 50],
      [now - 50, now - 100, now - 50],
    ]) {
      const client = redis({
        eval: vi.fn(async () => [
          personal ? String(personal) : null,
          global ? String(global) : null,
          now,
        ]),
      });
      await expect(readSessionRevocationState(client, 'portal', 'c')).resolves.toEqual({
        cutoffMs: expected,
        nowMs: now,
      });
      expect(client.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('TIME')"),
        2,
        'revoke:portal:c',
        'revoke:all',
      );
    }
  });

  it.each(
    [
      [],
      [null],
      [null, 1000],
      ['bad', null, 1000],
      [null, 'bad', 1000],
      [null, null, 0],
      [null, null, '1000'],
      [null, null, 123.5],
    ].map((reply) => ({
      reply,
    })),
  )('verwirft eine unlesbare Antwort ($reply)', async ({ reply }) => {
    await expect(
      readSessionRevocationState(redis({ eval: vi.fn(async () => reply) }), 'staff', 's'),
    ).rejects.toBeInstanceOf(SessionRevocationUnavailableError);
  });
});
