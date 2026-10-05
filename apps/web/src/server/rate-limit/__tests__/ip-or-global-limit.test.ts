// Fachkatalog: ACCESS-TENANT-RLS-001
// S-03: Ohne Client-IP darf kein kleiner gemeinsamer Zähler alle Nutzer
// sperren. Der Subjekt-Bucket (z. B. E-Mail-HMAC) gilt mit und ohne IP; ohne
// IP bleibt daneben nur die großzügige Sturm-Obergrenze. Echter Limiter gegen
// einen zustandsbehafteten Redis-Double (INCR + TTL wie das Lua-Skript).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    AUTH_SECRET: 'test-only-rate-limit-subject-secret-0123456789',
  } as Record<string, unknown>,
  counters: new Map<string, { count: number; until: number }>(),
  eval: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/redis', () => ({ getRedis: () => ({ eval: h.eval, del: vi.fn() }) }));

import {
  STORM_CEILING_PER_SECOND,
  checkIpOrGlobalLimit,
  emailRateLimitKey,
  stormCeiling,
} from '../index';

const PER_IP = { max: 5, windowSec: 900 };
const NOW = new Date('2026-10-05T08:00:00Z');

function subject(email: string, limit = PER_IP) {
  return { key: emailRateLimitKey(email), limit };
}

function count(key: string): number {
  return h.counters.get(`rl:${key}`)?.count ?? 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.counters.clear();
  h.env.AUTH_SECRET = 'test-only-rate-limit-subject-secret-0123456789';
  h.eval.mockReset();
  h.eval.mockImplementation(async (_script, _keys, key: string, window: string) => {
    let entry = h.counters.get(key);
    if (!entry || entry.until <= Date.now()) {
      entry = { count: 0, until: Date.now() + Number(window) * 1000 };
      h.counters.set(key, entry);
    }
    entry.count++;
    return [entry.count, Math.ceil((entry.until - Date.now()) / 1000)];
  });
});

afterEach(() => vi.useRealTimers());

describe('emailRateLimitKey', () => {
  it('pseudonymisiert die normalisierte Adresse ohne Rohwert', () => {
    const key = emailRateLimitKey('  Mandant@Example.DE ');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(emailRateLimitKey('mandant@example.de'));
    expect(key).not.toBe(emailRateLimitKey('mandantin@example.de'));
    expect(key).not.toContain('mandant');
  });

  it('hängt vom Server-Secret ab (kein Wörterbuch-Rückrechnen ohne AUTH_SECRET)', () => {
    const before = emailRateLimitKey('mandant@example.de');
    h.env.AUTH_SECRET = 'another-test-only-rate-limit-secret-0123456789';
    expect(emailRateLimitKey('mandant@example.de')).not.toBe(before);
  });
});

describe('checkIpOrGlobalLimit ohne Client-IP', () => {
  it('trennt verschiedene E-Mail-Adressen: eine gedrosselte Adresse blockiert keine andere', async () => {
    for (let i = 0; i < PER_IP.max; i++) {
      expect(
        (await checkIpOrGlobalLimit('portal-magic', null, PER_IP, subject('opfer@example.de'))).ok,
      ).toBe(true);
    }
    const blocked = await checkIpOrGlobalLimit(
      'portal-magic',
      null,
      PER_IP,
      subject('opfer@example.de'),
    );
    expect(blocked).toMatchObject({ ok: false, retryAfter: 900 });
    await expect(
      checkIpOrGlobalLimit('portal-magic', null, PER_IP, subject('andere@example.de')),
    ).resolves.toMatchObject({ ok: true });
    // Kein Schlüssel enthält die Adresse.
    expect([...h.counters.keys()].join(' ')).not.toContain('@');
  });

  it('lässt abgewiesene Subjekt-Anfragen die gemeinsame Obergrenze nicht verbrauchen', async () => {
    for (let i = 0; i < 50; i++) {
      await checkIpOrGlobalLimit('portal-magic', null, PER_IP, subject('opfer@example.de'));
    }
    expect(count(`portal-magic:subject:${emailRateLimitKey('opfer@example.de')}`)).toBe(50);
    expect(count('portal-magic:global')).toBe(PER_IP.max);
  });

  it('wendet die Sturm-Obergrenze weiterhin an, auch für wechselnde Subjekte', async () => {
    const tiny = { max: 1, windowSec: 2 };
    const ceiling = stormCeiling(tiny.windowSec).max;
    expect(ceiling).toBe(STORM_CEILING_PER_SECOND * 2);
    for (let i = 0; i < ceiling; i++) {
      const result = await checkIpOrGlobalLimit(
        'portal-magic',
        null,
        tiny,
        subject(`nutzer-${i}@example.de`, tiny),
      );
      expect(result.ok).toBe(true);
    }
    await expect(
      checkIpOrGlobalLimit('portal-magic', null, tiny, subject('neu@example.de', tiny)),
    ).resolves.toMatchObject({ ok: false });
    // Fenster abgelaufen → wieder frei.
    vi.setSystemTime(new Date(NOW.getTime() + 3_000));
    await expect(
      checkIpOrGlobalLimit('portal-magic', null, tiny, subject('neu@example.de', tiny)),
    ).resolves.toMatchObject({ ok: true });
  });

  it('nutzt ohne Subjekt nur die großzügige Sturm-Obergrenze statt einer kleinen globalen Quote', async () => {
    const perIp = { max: 10, windowSec: 600 };
    // Die alte globale Quote (200/10 min) ist längst überschritten.
    for (let i = 0; i < 1_000; i++) {
      expect((await checkIpOrGlobalLimit('poa-load', null, perIp)).ok).toBe(true);
    }
    expect(count('poa-load:global')).toBe(1_000);
    expect(h.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      'rl:poa-load:global',
      String(perIp.windowSec),
    );
    expect(stormCeiling(600)).toEqual({ max: 6_000, windowSec: 600 });
  });
});

describe('checkIpOrGlobalLimit mit Client-IP', () => {
  it('prüft zusätzlich den Subjekt-Bucket, damit rotierende IPs ihn nicht umgehen', async () => {
    for (let i = 0; i < PER_IP.max; i++) {
      const ok = await checkIpOrGlobalLimit(
        'portal-magic',
        `203.0.113.${i + 1}`,
        PER_IP,
        subject('opfer@example.de'),
      );
      expect(ok.ok).toBe(true);
    }
    await expect(
      checkIpOrGlobalLimit('portal-magic', '203.0.113.99', PER_IP, subject('opfer@example.de')),
    ).resolves.toMatchObject({ ok: false });
    expect(count('portal-magic:global')).toBe(0);
  });

  it('prüft zuerst die IP: eine einzelne Quelle verbraucht höchstens perIp.max vom Subjekt', async () => {
    const wideSubject = subject('opfer@example.de', { max: 10, windowSec: 900 });
    for (let i = 0; i < 20; i++) {
      await checkIpOrGlobalLimit('portal-magic', '198.51.100.7', PER_IP, wideSubject);
    }
    expect(count(`portal-magic:subject:${wideSubject.key}`)).toBe(PER_IP.max);
    await expect(
      checkIpOrGlobalLimit('portal-magic', '203.0.113.1', PER_IP, wideSubject),
    ).resolves.toMatchObject({ ok: true });
  });

  it('bleibt ohne Subjekt beim reinen Per-IP-Bucket', async () => {
    for (let i = 0; i < PER_IP.max; i++) {
      expect((await checkIpOrGlobalLimit('staff-pw', '203.0.113.5', PER_IP)).ok).toBe(true);
    }
    await expect(checkIpOrGlobalLimit('staff-pw', '203.0.113.5', PER_IP)).resolves.toMatchObject({
      ok: false,
    });
    await expect(checkIpOrGlobalLimit('staff-pw', '203.0.113.6', PER_IP)).resolves.toMatchObject({
      ok: true,
    });
    expect([...h.counters.keys()]).toEqual(['rl:staff-pw:203.0.113.5', 'rl:staff-pw:203.0.113.6']);
  });
});
