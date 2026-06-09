// =============================================================================
// Unit-Tests: Account-Lockout (apps/web/src/server/auth/lockout.ts).
//
// recordFailedLogin/resetFailedLogin bekommen den Prisma-Client per Parameter
// (DI) — nur `getRedis` ist fest verdrahtet und wird gemockt. Abgedeckt:
//   - Fallback-Semantik ohne Redis: Lock bei failedLoginCount ≥ Schwelle
//   - L-4: mit Redis zählt die Anzahl DISTINKTER Quell-IPs — Single-IP-Spam
//     sperrt den Account NICHT (kein Lockout-DoS), erst ≥ 5 verschiedene IPs
//   - ip null/'unknown' und Redis-Fehler → Fallback auf den Count
//   - Lock setzt lockedUntil = now + LOCK_DURATION_MS und resettet den Zähler
//   - resetFailedLogin: Zähler + Distinct-IP-Set zurück, lockedUntil bleibt
//
// Fake-Clock macht lockedUntil deterministisch.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { getRedisMock } = vi.hoisted(() => ({
  getRedisMock: vi.fn<() => unknown>(),
}));

vi.mock('@/server/redis', () => ({
  getRedis: getRedisMock,
}));

import {
  recordFailedLogin,
  resetFailedLogin,
  MAX_FAILED_LOGIN_ATTEMPTS,
  LOCK_DURATION_MS,
} from '../lockout';

const USER_ID = 'staff-user-1';
const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');

function makePrisma(failedLoginCount: number) {
  const update = vi.fn().mockResolvedValue({ failedLoginCount });
  return { prisma: { staffUser: { update } } as unknown as PrismaClient, update };
}

function makeRedis(scardResult: number) {
  return {
    sadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    scard: vi.fn().mockResolvedValue(scardResult),
    del: vi.fn().mockResolvedValue(1),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  getRedisMock.mockReset();
  getRedisMock.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordFailedLogin — Fallback ohne Redis (Count-Semantik)', () => {
  it('unter der Schwelle → nur Increment, kein Lock', async () => {
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS - 1);
    await recordFailedLogin(prisma, USER_ID, '203.0.113.1');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
  });

  it('Schwelle erreicht → Lock mit lockedUntil = now + LOCK_DURATION_MS, Zähler-Reset', async () => {
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await recordFailedLogin(prisma, USER_ID, '203.0.113.1');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith({
      where: { id: USER_ID },
      data: {
        lockedUntil: new Date(FIXED_NOW.getTime() + LOCK_DURATION_MS),
        failedLoginCount: 0,
      },
    });
  });
});

describe('recordFailedLogin — L-4: Distinct-IP-Semantik mit Redis', () => {
  it('viele Fehlversuche von EINER IP → KEIN Lock (kein Lockout-DoS)', async () => {
    getRedisMock.mockReturnValue(makeRedis(1)); // nur 1 distinkte IP
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS + 2);
    await recordFailedLogin(prisma, USER_ID, '203.0.113.1');
    expect(update).toHaveBeenCalledTimes(1); // kein Lock-Update
  });

  it('≥ 5 distinkte IPs → Lock + Distinct-IP-Set wird geleert', async () => {
    const redis = makeRedis(MAX_FAILED_LOGIN_ATTEMPTS);
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(1); // Count selbst ist niedrig
    await recordFailedLogin(prisma, USER_ID, '203.0.113.5');
    expect(update).toHaveBeenCalledTimes(2);
    expect(redis.sadd).toHaveBeenCalledWith(`staff-fail-ips:${USER_ID}`, '203.0.113.5');
    expect(redis.del).toHaveBeenCalledWith(`staff-fail-ips:${USER_ID}`);
  });

  it('ip null → Distinct-IP-Zählung übersprungen, Fallback auf Count', async () => {
    const redis = makeRedis(1);
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await recordFailedLogin(prisma, USER_ID, null);
    expect(redis.scard).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2); // Lock über Count-Fallback
  });

  it("ip 'unknown' (Proxy-Fehlkonfiguration) → Fallback auf Count", async () => {
    const redis = makeRedis(1);
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await recordFailedLogin(prisma, USER_ID, 'unknown');
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('Redis-Fehler beim sadd → Fallback auf Count (Layer bleibt aktiv)', async () => {
    const redis = makeRedis(1);
    redis.sadd.mockRejectedValue(new Error('redis down'));
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await recordFailedLogin(prisma, USER_ID, '203.0.113.1');
    expect(update).toHaveBeenCalledTimes(2); // Lock trotz Redis-Ausfall
  });

  it('unter 5 distinkten IPs und Count unter Schwelle → kein Lock', async () => {
    getRedisMock.mockReturnValue(makeRedis(MAX_FAILED_LOGIN_ATTEMPTS - 1));
    const { prisma, update } = makePrisma(1);
    await recordFailedLogin(prisma, USER_ID, '203.0.113.4');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('resetFailedLogin', () => {
  it('setzt den Zähler zurück, fasst lockedUntil NICHT an', async () => {
    const { prisma, update } = makePrisma(0);
    await resetFailedLogin(prisma, USER_ID);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { failedLoginCount: 0 },
    });
  });

  it('leert das Distinct-IP-Set (L-4: legitime Mehrfach-Logins summieren sich nicht)', async () => {
    const redis = makeRedis(0);
    getRedisMock.mockReturnValue(redis);
    const { prisma } = makePrisma(0);
    await resetFailedLogin(prisma, USER_ID);
    expect(redis.del).toHaveBeenCalledWith(`staff-fail-ips:${USER_ID}`);
  });

  it('ohne Redis → kein Fehler', async () => {
    const { prisma } = makePrisma(0);
    await expect(resetFailedLogin(prisma, USER_ID)).resolves.toBeUndefined();
  });
});
