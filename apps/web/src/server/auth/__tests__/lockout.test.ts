// =============================================================================
// Unit-Tests: Account-Lockout (apps/web/src/server/auth/lockout.ts).
//
// recordFailedLogin/resetFailedLogin bekommen den Prisma-Client per Parameter
// (DI) — nur `getRedis` ist fest verdrahtet und wird gemockt. Abgedeckt:
//   - Fallback-Semantik ohne Redis (IP bekannt): Lock bei failedLoginCount ≥ Schwelle
//   - L-4: mit Redis zählt die Anzahl DISTINKTER Quell-IPs — Single-IP-Spam
//     sperrt den Account NICHT (kein Lockout-DoS), erst ≥ 5 verschiedene IPs
//   - Redis-Fehler (IP bekannt) → Fallback auf den Count
//   - S-03: ip null/'unknown' → nur zählen, NIE sperren (sonst sperrten fünf
//     anonyme Fehlversuche jedes bekannte Konto 30 min)
//   - Lock setzt lockedUntil = now + LOCK_DURATION_MS und resettet den Zähler
//   - resetFailedLogin: Zähler + Distinct-IP-Set zurück, lockedUntil bleibt
//
// Fake-Clock macht lockedUntil deterministisch.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { getRedisMock, logWarn } = vi.hoisted(() => ({
  getRedisMock: vi.fn<() => unknown>(),
  logWarn: vi.fn(),
}));

vi.mock('@/server/redis', () => ({
  getRedis: getRedisMock,
}));
vi.mock('@/server/logger', () => ({ log: { warn: logWarn } }));

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
  logWarn.mockReset();
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

  it('Redis-Ausfall nach der IP-Erfassung → Fallback auf Count bleibt mit bekannter IP', async () => {
    const redis = makeRedis(1);
    redis.scard.mockRejectedValue(new Error('redis down'));
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await expect(recordFailedLogin(prisma, USER_ID, '203.0.113.1')).resolves.toEqual({
      locked: true,
    });
    expect(update).toHaveBeenCalledTimes(2);
    // F-05: der Redis-Ausfall bleibt nicht still — ohne Konto-ID und IP im Log.
    expect(logWarn).toHaveBeenCalledExactlyOnceWith(
      { component: 'lockout', err: 'redis down' },
      'lockout: Redis-Zählung der Fehlversuchs-IPs fehlgeschlagen',
    );
    expect(JSON.stringify(logWarn.mock.calls)).not.toMatch(/staff-user-1|203\.0\.113/);
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

describe('recordFailedLogin — S-03: ohne vertrauenswürdige Client-IP keine harte Sperre', () => {
  it('ip null → zählt den Fehlversuch, sperrt aber auch weit über der Schwelle nicht', async () => {
    const redis = makeRedis(MAX_FAILED_LOGIN_ATTEMPTS);
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS * 10);
    await expect(recordFailedLogin(prisma, USER_ID, null)).resolves.toEqual({ locked: false });
    expect(update).toHaveBeenCalledExactlyOnceWith({
      where: { id: USER_ID },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("ip 'unknown' (Legacy-Sentinel) → ebenfalls keine Sperre", async () => {
    const redis = makeRedis(1);
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await expect(recordFailedLogin(prisma, USER_ID, 'unknown')).resolves.toEqual({
      locked: false,
    });
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('ohne IP und ohne Redis → keine Sperre (kein Count-Fallback für anonyme Versuche)', async () => {
    const { prisma, update } = makePrisma(MAX_FAILED_LOGIN_ATTEMPTS);
    await expect(recordFailedLogin(prisma, USER_ID)).resolves.toEqual({ locked: false });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('fünf und mehr anonyme Fehlversuche in Folge sperren das Konto nie', async () => {
    let failedLoginCount = 0;
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data['lockedUntil']) throw new Error('Konto darf ohne IP nicht gesperrt werden');
      failedLoginCount += 1;
      return { failedLoginCount };
    });
    const prisma = { staffUser: { update } } as unknown as PrismaClient;
    getRedisMock.mockReturnValue(makeRedis(0));
    for (let attempt = 0; attempt < MAX_FAILED_LOGIN_ATTEMPTS * 4; attempt++) {
      await expect(recordFailedLogin(prisma, USER_ID, null)).resolves.toEqual({ locked: false });
    }
    expect(failedLoginCount).toBe(MAX_FAILED_LOGIN_ATTEMPTS * 4);
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

  it('F-06: ein gescheitertes Leeren des Sets wird geloggt, der Reset gelingt trotzdem', async () => {
    const redis = makeRedis(0);
    redis.del.mockRejectedValue(new Error('redis down'));
    getRedisMock.mockReturnValue(redis);
    const { prisma, update } = makePrisma(0);
    await expect(resetFailedLogin(prisma, USER_ID)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledExactlyOnceWith(
      { component: 'lockout', err: 'redis down' },
      'lockout: Redis-DEL der Fehlversuchs-IPs fehlgeschlagen',
    );
  });
});
