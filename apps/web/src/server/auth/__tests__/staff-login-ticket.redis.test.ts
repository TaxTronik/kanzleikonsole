// Fachkatalog: ACCESS-TENANT-RLS-001.
// R-04: Opt-in integration against a disposable Redis, never the application REDIS_URL.
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ redis: null as unknown }));
vi.mock('@/server/redis', () => ({ getRedis: () => h.redis }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import {
  STAFF_LOGIN_TICKET_TTL_SECONDS,
  consumeStaffLoginTicket,
  issueStaffLoginTicket,
} from '../staff-login-ticket';

const redisUrl = process.env.AUTH_LOGIN_TICKET_TEST_REDIS_URL;

describe.skipIf(!redisUrl)('R-04: real Redis login tickets', () => {
  let redis: Redis;

  beforeAll(async () => {
    const url = new URL(redisUrl!);
    if (url.hostname !== '127.0.0.1' || url.port === '6379') {
      throw new Error('Use a disposable Redis on an explicit non-default loopback port');
    }
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: 0, retryStrategy: () => null });
    await redis.ping();
    h.redis = redis;
  });
  afterAll(async () => {
    if (redis) {
      const keys = await redis.keys('staff-login-ticket:*');
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
  });

  it('redeems a ticket exactly once under concurrent attempts and stores only its hash', async () => {
    const ticket = await issueStaffLoginTicket('second-factor', {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      authRevision: 7,
      passwordHash: '$2b$12$fixture',
    });
    const keys = await redis.keys('staff-login-ticket:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(ticket);
    const ttl = await redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(STAFF_LOGIN_TICKET_TTL_SECONDS);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeStaffLoginTicket(ticket, 'second-factor')),
    );
    expect(results.filter(Boolean)).toEqual([
      expect.objectContaining({ authRevision: 7, purpose: 'second-factor' }),
    ]);
    await expect(redis.keys('staff-login-ticket:*')).resolves.toEqual([]);
  });
});
