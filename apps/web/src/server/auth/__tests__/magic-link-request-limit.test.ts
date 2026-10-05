// Fachkatalog: ACCESS-TENANT-RLS-001
// S-03: Magic-Link-Anforderung ohne vertrauenswürdige Client-IP. Früher teilten
// sich alle Anfragen 100 Versuche je 15 min; eine Anfrage alle 9 s blockierte
// sämtliche Portal-Logins. Echte Server-Action und echter Limiter gegen einen
// zustandsbehafteten Redis-Double; nur Persistenz und Versand sind ersetzt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  headers: new Headers(),
  requestMagicLink: vi.fn(),
  tenantFindFirst: vi.fn(),
  counters: new Map<string, { count: number; until: number }>(),
}));

vi.mock('next/headers', () => ({ headers: async () => h.headers, cookies: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/auth/magic-link', () => ({
  requestMagicLink: h.requestMagicLink,
  verifyMagicLink: vi.fn(),
  inspectMagicLink: vi.fn(),
}));
vi.mock('@/server/auth/portal-session', () => ({ writePortalSession: vi.fn() }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { tenant: { findFirst: h.tenantFindFirst } },
}));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    del: vi.fn(),
    eval: async (_script: string, _keys: number, key: string, window: string) => {
      let entry = h.counters.get(key);
      if (!entry || entry.until <= Date.now()) {
        entry = { count: 0, until: Date.now() + Number(window) * 1000 };
        h.counters.set(key, entry);
      }
      entry.count++;
      return [entry.count, Math.ceil((entry.until - Date.now()) / 1000)];
    },
  }),
}));

import { requestMagicLinkAction } from '@/app/portal/(auth)/login/actions';

const NOW = new Date('2026-10-05T08:00:00Z');
const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'test-only-magic-link-limit-secret-0123456789',
};

function configure(trustProxy: boolean): void {
  for (const key of Object.keys(h.env)) delete h.env[key];
  Object.assign(h.env, PRODUCTION, { TRUST_PROXY_REQUIRED: trustProxy, TRUST_PROXY_HOPS: 1 });
}

function request(email: string, forwardedFor = '203.0.113.50') {
  h.headers = new Headers({ 'x-forwarded-for': forwardedFor });
  const form = new FormData();
  form.set('email', email);
  form.set('tenantSlug', 'default');
  return requestMagicLinkAction(null, form);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.counters.clear();
  configure(false);
  h.tenantFindFirst.mockResolvedValue({ id: 'tenant-1' });
  h.requestMagicLink.mockResolvedValue({ ok: true });
});

afterEach(() => vi.useRealTimers());

describe('S-03: Magic-Link-Anforderung ohne Client-IP', () => {
  it('blockiert nach mehr als 100 fremden Anfragen nicht mehr alle Portal-Logins', async () => {
    for (let i = 0; i < 150; i++) {
      await expect(request(`angreifer-${i}@example.test`)).resolves.toEqual({ ok: true });
    }
    await expect(request('mandant@example.test')).resolves.toEqual({ ok: true });
    expect(h.requestMagicLink).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', email: 'mandant@example.test' }),
    );
  });

  it('drosselt pro E-Mail-Adresse, ohne andere Adressen zu treffen', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(request('Opfer@Example.test')).resolves.toEqual({ ok: true });
    }
    // Groß-/Kleinschreibung führt in denselben Bucket.
    await expect(request('OPFER@EXAMPLE.TEST')).resolves.toMatchObject({
      ok: false,
      error: 'Zu viele Anfragen. Bitte 15 Min. warten.',
    });
    await expect(request('nachbar@example.test')).resolves.toEqual({ ok: true });
    expect(h.requestMagicLink).toHaveBeenCalledTimes(6);
    // Redis sieht nie die Adresse selbst.
    expect([...h.counters.keys()].join(' ')).not.toMatch(/@|opfer|nachbar/i);
  });

  it('behandelt existierende und unbekannte Adressen identisch (kein Enumerations-Orakel)', async () => {
    // Die Action kennt die Existenz nicht vor requestMagicLink; der Subjekt-
    // Bucket greift für jede syntaktisch gültige Adresse gleich.
    const responses = [];
    for (const email of ['bekannt@example.test', 'unbekannt@example.test']) {
      const sequence = [];
      for (let i = 0; i < 6; i++) sequence.push(await request(email));
      responses.push(sequence);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(h.tenantFindFirst).toHaveBeenCalledTimes(10);
  });

  it('reicht ohne Client-IP die Versandobergrenze an den Versand weiter', async () => {
    await request('mandant@example.test');
    expect(h.requestMagicLink).toHaveBeenCalledWith(
      expect.objectContaining({ mailCeiling: { max: 100, windowSec: 900 } }),
    );
  });

  it('lehnt ungültige Adressen ab, ohne Kontingente zu verbrauchen', async () => {
    await expect(request('keine-adresse')).resolves.toMatchObject({ ok: false });
    expect(h.counters.size).toBe(0);
  });
});

describe('S-03: Magic-Link-Anforderung mit Client-IP', () => {
  beforeEach(() => configure(true));

  it('begrenzt dieselbe Adresse auch über rotierende IPs', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(request('opfer@example.test', `198.51.100.${i + 1}`)).resolves.toEqual({
        ok: true,
      });
    }
    await expect(request('opfer@example.test', '198.51.100.99')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('nimmt die IP vom rechten Ende und ignoriert gefälschte linke Einträge', async () => {
    for (let i = 0; i < 5; i++) {
      await request(`nutzer-${i}@example.test`, `10.0.0.${i}, 203.0.113.7`);
    }
    await expect(request('nutzer-6@example.test', '10.9.9.9, 203.0.113.7')).resolves.toMatchObject({
      ok: false,
    });
    await expect(request('nutzer-7@example.test', '203.0.113.8')).resolves.toEqual({ ok: true });
  });

  it('verzichtet mit Client-IP auf die globale Versandobergrenze', async () => {
    await request('mandant@example.test');
    expect(h.requestMagicLink).toHaveBeenCalledWith(
      expect.not.objectContaining({ mailCeiling: expect.anything() }),
    );
  });
});
