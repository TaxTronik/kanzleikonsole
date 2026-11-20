// Fachkatalog: ACCESS-TENANT-RLS-001.
// Opt-in integration against a disposable Redis, never the application REDIS_URL.
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ redis: null as unknown }));
vi.mock('@/server/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import { advanceGlobalSessionRevocation } from '@taxtronik/crypto';
import { getRevocationTimestamp, isTokenRevoked, revokeAllSessions } from '../revocation';
import { newSessionIssueTime } from '../session-issued-at';

const redisUrl = process.env.AUTH_REVOCATION_TEST_REDIS_URL;

describe.skipIf(!redisUrl)('ACCESS-TENANT-RLS-001: real Redis revocation ordering', () => {
  let redis: Redis;
  const keys: string[] = [];

  function user() {
    const id = `auth-revocation-test-${randomUUID()}`;
    keys.push(`revoke:portal:${id}`, `revoke:staff:${id}`);
    return id;
  }

  beforeAll(async () => {
    const url = new URL(redisUrl!);
    if (url.hostname !== '127.0.0.1' || url.port === '6379') {
      throw new Error('Use a disposable Redis on an explicit non-default loopback port');
    }
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 0, retryStrategy: () => null });
    await redis.ping();
  });
  afterEach(() => {
    vi.useRealTimers();
    h.redis = redis;
  });
  afterAll(async () => {
    if (redis) {
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
  });

  it('does not resurrect a revoked token when an older write arrives after a newer cutoff', async () => {
    const id = user();
    h.redis = redis;
    const issued = await newSessionIssueTime();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWrite = true;
    h.redis = new Proxy(redis, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'set' && property !== 'eval') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          if (firstWrite && typeof args[0] === 'string' && args[0].includes("redis.call('SET'")) {
            firstWrite = false;
            await delayed;
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    const olderWrite = revokeAllSessions('portal', id);
    try {
      await revokeAllSessions('portal', id);
      expect(
        await isTokenRevoked('portal', id, issued.sessionIssuedAt, issued.sessionIssuedAtMs),
      ).toBe(true);
      // Ein jüngerer, bereits gespeicherter Cutoff bleibt auch nach einem
      // verzögerten Schreibvorgang oder rückwärts gestellter Redis-Uhr erhalten.
      const newerCutoff = (await getRevocationTimestamp('portal', id)) + 60_000;
      await redis.set(`revoke:portal:${id}`, String(newerCutoff));
      release();
      await olderWrite;
      expect(
        await isTokenRevoked('portal', id, issued.sessionIssuedAt, issued.sessionIssuedAtMs),
      ).toBe(true);
      expect(await getRevocationTimestamp('portal', id)).toBe(newerCutoff);
      expect(await redis.ttl(`revoke:portal:${id}`)).toBeGreaterThan(2_591_990);
      expect(await getRevocationTimestamp('staff', id)).toBe(0);
    } finally {
      release();
      await olderWrite;
    }
  });

  it('preserves an unreadable cutoff and fails closed instead of replacing it', async () => {
    const id = user();
    h.redis = redis;
    await redis.set(`revoke:portal:${id}`, 'invalid-existing-cutoff');
    await expect(revokeAllSessions('portal', id)).rejects.toThrow();
    expect(await redis.get(`revoke:portal:${id}`)).toBe('invalid-existing-cutoff');
    expect(await isTokenRevoked('portal', id, Math.floor(Date.now() / 1000) + 1)).toBe(true);
  });

  it.each(['staff', 'portal'] as const)(
    'compares precise and legacy %s logins with a real cutoff',
    async (surface) => {
      const id = user();
      h.redis = redis;
      vi.useFakeTimers({ toFake: ['Date'] });
      const actualTime = await newSessionIssueTime();
      expect(
        await isTokenRevoked(surface, id, actualTime.sessionIssuedAt, actualTime.sessionIssuedAtMs),
      ).toBe(false);
      const future = actualTime.sessionIssuedAtMs + 60_000;
      expect(await isTokenRevoked(surface, id, Math.floor(future / 1000), future)).toBe(true);
      vi.setSystemTime(new Date(actualTime.sessionIssuedAtMs + 300));
      const login = await newSessionIssueTime();
      vi.setSystemTime(new Date(actualTime.sessionIssuedAtMs - 300));
      await revokeAllSessions(surface, id);
      const cutoff = await getRevocationTimestamp(surface, id);
      expect(cutoff).toBeGreaterThanOrEqual(login.sessionIssuedAtMs);
      expect(
        await isTokenRevoked(surface, id, login.sessionIssuedAt, login.sessionIssuedAtMs),
      ).toBe(true);
      const sec = Math.floor(cutoff / 1000);
      expect(await isTokenRevoked(surface, id, sec)).toBe(true);
      expect(await isTokenRevoked(surface, id, Math.floor((cutoff - 1) / 1000), cutoff - 1)).toBe(
        true,
      );
      expect(await isTokenRevoked(surface, id, sec, cutoff)).toBe(true);
      await expect
        .poll(async () => (await newSessionIssueTime()).sessionIssuedAtMs)
        .toBeGreaterThan(cutoff);
      expect(await isTokenRevoked(surface, id, Math.floor((cutoff + 1) / 1000), cutoff + 1)).toBe(
        false,
      );
    },
  );

  it('sperrt nach verlorenem Redis-Zustand alle älteren Sitzungen über den globalen Stichtag', async () => {
    // CVP-Nachprüfung 20.11.2026, Befund 2: Ein zurückgespielter älterer
    // Redis-Stand enthält den persönlichen Widerruf nicht mehr.
    h.redis = redis;
    keys.push('revoke:all');
    const loggedOut = user();
    const other = user();
    const first = await newSessionIssueTime();
    const second = await newSessionIssueTime();
    await revokeAllSessions('staff', loggedOut);
    expect(
      await isTokenRevoked('staff', loggedOut, first.sessionIssuedAt, first.sessionIssuedAtMs),
    ).toBe(true);
    // Verlust wie nach dem Restore: der persönliche Stichtag fehlt.
    await redis.del(`revoke:staff:${loggedOut}`);
    expect(
      await isTokenRevoked('staff', loggedOut, first.sessionIssuedAt, first.sessionIssuedAtMs),
    ).toBe(false);

    await advanceGlobalSessionRevocation(redis);
    for (const [surface, id, issued] of [
      ['staff', loggedOut, first],
      ['portal', other, second],
    ] as const) {
      expect(
        await isTokenRevoked(surface, id, issued.sessionIssuedAt, issued.sessionIssuedAtMs),
      ).toBe(true);
      expect(await isTokenRevoked(surface, id, issued.sessionIssuedAt)).toBe(true);
    }
    const global = Number(await redis.get('revoke:all'));
    expect(await redis.ttl('revoke:all')).toBeGreaterThan(24 * 60 * 60);
    await expect
      .poll(async () => (await newSessionIssueTime()).sessionIssuedAtMs)
      .toBeGreaterThan(global);
    const fresh = await newSessionIssueTime();
    expect(
      await isTokenRevoked('staff', loggedOut, fresh.sessionIssuedAt, fresh.sessionIssuedAtMs),
    ).toBe(false);
  });
});
