import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getRedis: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/server/redis', () => ({ getRedis: m.getRedis }));
vi.mock('@/server/logger', () => ({ log: { warn: m.logWarn } }));

import { getRevocationTimestamp, isTokenRevoked, revokeAllSessions } from '../revocation';

const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');
const REVOKE_TTL_SEC = 30 * 24 * 60 * 60;

function makeRedis() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.clearAllMocks();
  m.getRedis.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('revokeAllSessions', () => {
  it('writes a per-surface user timestamp with a 30 day ttl', async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue('OK');
    m.getRedis.mockReturnValue(redis);

    await revokeAllSessions('staff', 'staff-1');

    expect(redis.set).toHaveBeenCalledWith(
      'revoke:staff:staff-1',
      String(FIXED_NOW.getTime()),
      'EX',
      REVOKE_TTL_SEC,
    );
  });

  it('does nothing when Redis is unavailable', async () => {
    await expect(revokeAllSessions('portal', 'contact-1')).resolves.toBeUndefined();
    expect(m.logWarn).not.toHaveBeenCalled();
  });

  it('logs and swallows Redis write failures', async () => {
    const redis = makeRedis();
    redis.set.mockRejectedValue(new Error('redis down'));
    m.getRedis.mockReturnValue(redis);

    await expect(revokeAllSessions('staff', 'staff-1')).resolves.toBeUndefined();

    expect(m.logWarn).toHaveBeenCalledWith(
      { component: 'revocation', err: 'redis down' },
      'revoke failed',
    );
  });
});

describe('getRevocationTimestamp', () => {
  it('returns 0 without Redis or without a stored timestamp', async () => {
    expect(await getRevocationTimestamp('staff', 'staff-1')).toBe(0);

    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    m.getRedis.mockReturnValue(redis);

    expect(await getRevocationTimestamp('staff', 'staff-1')).toBe(0);
  });

  it('returns the stored numeric timestamp', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(String(FIXED_NOW.getTime()));
    m.getRedis.mockReturnValue(redis);

    expect(await getRevocationTimestamp('portal', 'contact-1')).toBe(FIXED_NOW.getTime());
    expect(redis.get).toHaveBeenCalledWith('revoke:portal:contact-1');
  });

  it('logs and fail-opens to 0 on Redis read errors', async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValue(new Error('redis read failed'));
    m.getRedis.mockReturnValue(redis);

    expect(await getRevocationTimestamp('staff', 'staff-1')).toBe(0);
    expect(m.logWarn).toHaveBeenCalledWith(
      { component: 'revocation', err: 'redis read failed' },
      'revocation timestamp read failed',
    );
  });
});

describe('isTokenRevoked', () => {
  it('does not revoke tokens without iat', async () => {
    expect(await isTokenRevoked('staff', 'staff-1', undefined)).toBe(false);
  });

  it('revokes tokens issued before the stored timestamp', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(String(FIXED_NOW.getTime()));
    m.getRedis.mockReturnValue(redis);

    const oneSecondBefore = Math.floor(FIXED_NOW.getTime() / 1000) - 1;

    expect(await isTokenRevoked('staff', 'staff-1', oneSecondBefore)).toBe(true);
  });

  it('keeps tokens issued at or after the stored timestamp', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(String(FIXED_NOW.getTime()));
    m.getRedis.mockReturnValue(redis);

    const sameSecond = Math.floor(FIXED_NOW.getTime() / 1000);
    const oneSecondAfter = sameSecond + 1;

    expect(await isTokenRevoked('portal', 'contact-1', sameSecond)).toBe(false);
    expect(await isTokenRevoked('portal', 'contact-1', oneSecondAfter)).toBe(false);
  });
});
