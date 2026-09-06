import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Fachkatalog: ACCESS-TENANT-RLS-001.

const m = vi.hoisted(() => ({
  getRedis: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/server/redis', () => ({ getRedis: m.getRedis }));
vi.mock('@/server/logger', () => ({ log: { warn: m.logWarn } }));

import {
  getRevocationTimestamp,
  isTokenRevoked,
  revokeAllSessions,
  SessionRevocationUnavailableError,
} from '../revocation';

const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');
const REVOKE_TTL_SEC = 30 * 24 * 60 * 60;

function makeRedis() {
  return {
    get: vi.fn(),
    eval: vi.fn(),
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
    redis.eval.mockResolvedValue('OK');
    m.getRedis.mockReturnValue(redis);

    await revokeAllSessions('staff', 'staff-1');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'revoke:staff:staff-1',
      String(FIXED_NOW.getTime()),
      REVOKE_TTL_SEC,
    );
  });

  it('fails closed when Redis is unavailable', async () => {
    await expect(revokeAllSessions('portal', 'contact-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
    expect(m.logWarn).toHaveBeenCalledWith(
      { component: 'revocation', err: 'Session-Widerruf ist derzeit nicht verfügbar.' },
      'revoke failed',
    );
  });

  it('logs and propagates Redis write failures as a stable security error', async () => {
    const redis = makeRedis();
    redis.eval.mockRejectedValue(new Error('redis down'));
    m.getRedis.mockReturnValue(redis);

    await expect(revokeAllSessions('staff', 'staff-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );

    expect(m.logWarn).toHaveBeenCalledWith(
      { component: 'revocation', err: 'redis down' },
      'revoke failed',
    );
  });

  it('rejects an unconfirmed Redis script result', async () => {
    const redis = makeRedis();
    redis.eval.mockResolvedValue(null);
    m.getRedis.mockReturnValue(redis);

    await expect(revokeAllSessions('staff', 'staff-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
  });
});

describe('getRevocationTimestamp', () => {
  it('fails closed without Redis and returns 0 only when Redis confirms no cutoff', async () => {
    await expect(getRevocationTimestamp('staff', 'staff-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );

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

  it('treats an existing empty cutoff as corrupt, never as an absent revocation', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue('');
    m.getRedis.mockReturnValue(redis);

    await expect(getRevocationTimestamp('portal', 'contact-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
    expect(await isTokenRevoked('portal', 'contact-1', Math.floor(Date.now() / 1000))).toBe(true);
  });

  it('logs and fails closed on Redis read errors', async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValue(new Error('redis read failed'));
    m.getRedis.mockReturnValue(redis);

    await expect(getRevocationTimestamp('staff', 'staff-1')).rejects.toBeInstanceOf(
      SessionRevocationUnavailableError,
    );
    expect(m.logWarn).toHaveBeenCalledWith(
      { component: 'revocation', err: 'redis read failed' },
      'revocation timestamp read failed',
    );
  });
});

describe('isTokenRevoked', () => {
  it('rejects tokens when the revocation store is unavailable', async () => {
    expect(await isTokenRevoked('staff', 'staff-1', undefined)).toBe(true);
  });

  it('accepts a token without iat only when Redis confirms there is no cutoff', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(null);
    m.getRedis.mockReturnValue(redis);

    expect(await isTokenRevoked('staff', 'staff-1', undefined)).toBe(false);
  });

  it('does not let a token without iat bypass an existing cutoff', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(String(FIXED_NOW.getTime()));
    m.getRedis.mockReturnValue(redis);

    expect(await isTokenRevoked('staff', 'staff-1', undefined)).toBe(true);
  });

  it('revokes tokens issued before the stored timestamp', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(String(FIXED_NOW.getTime()));
    m.getRedis.mockReturnValue(redis);

    const oneSecondBefore = Math.floor(FIXED_NOW.getTime() / 1000) - 1;

    expect(await isTokenRevoked('staff', 'staff-1', oneSecondBefore)).toBe(true);
  });

  it('revokes the complete cutoff second and keeps only later tokens', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValue(String(FIXED_NOW.getTime()));
    m.getRedis.mockReturnValue(redis);

    const sameSecond = Math.floor(FIXED_NOW.getTime() / 1000);
    const oneSecondAfter = sameSecond + 1;

    expect(await isTokenRevoked('portal', 'contact-1', sameSecond)).toBe(true);
    expect(await isTokenRevoked('portal', 'contact-1', oneSecondAfter)).toBe(false);
  });
});
