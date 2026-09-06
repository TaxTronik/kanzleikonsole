// Fachkatalog: ACCESS-TENANT-RLS-001.
// Opt-in integration against a disposable Redis, never the application REDIS_URL.
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ redis: null as unknown }));
vi.mock('@/server/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import { getRevocationTimestamp, isTokenRevoked, revokeAllSessions } from '../revocation';

const redisUrl = process.env.AUTH_REVOCATION_TEST_REDIS_URL;
const NOW = new Date('2026-09-06T12:00:00Z');

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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const id = user();
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
          if (firstWrite) {
            firstWrite = false;
            await delayed;
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    const olderWrite = revokeAllSessions('portal', id);
    try {
      vi.setSystemTime(new Date(NOW.getTime() + 2_000));
      await revokeAllSessions('portal', id);
      const tokenIssuedBetweenCutoffs = NOW.getTime() / 1000 + 1;
      expect(await isTokenRevoked('portal', id, tokenIssuedBetweenCutoffs)).toBe(true);
      release();
      await olderWrite;
      expect(await isTokenRevoked('portal', id, tokenIssuedBetweenCutoffs)).toBe(true);
      expect(await getRevocationTimestamp('portal', id)).toBe(NOW.getTime() + 2_000);
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
});
