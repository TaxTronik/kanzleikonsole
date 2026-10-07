// B3: Die Diagnose-Route des Deploy-Smokes liefert genau die Client-IP, die
// auch Rate-Limits, Kontosperren und Audit-Einträge verwenden (echtes
// getClientIp aus server/rate-limit, nur die ENV ist ersetzt), und sonst nichts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
}));

vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/redis', () => ({ getRedis: () => null }));

import { GET } from '../route';

function setEnv(values: Record<string, unknown>): void {
  for (const key of Object.keys(h.env)) delete h.env[key];
  Object.assign(h.env, values);
}

function request(forwardedFor?: string): Request {
  const headers = new Headers({ 'user-agent': 'vitest', host: 'kanzlei.example.test' });
  if (forwardedFor !== undefined) headers.set('x-forwarded-for', forwardedFor);
  return new Request('https://kanzlei.example.test/api/health/client-ip', { headers });
}

beforeEach(() => {
  setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: true, TRUST_PROXY_HOPS: 1 });
});

afterEach(() => setEnv({}));

describe('GET /api/health/client-ip', () => {
  it('liefert nur die ermittelte Client-IP (rechter X-Forwarded-For-Eintrag), ungecacht', async () => {
    const res = GET(request('6.6.6.6, 203.0.113.9'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toStrictEqual({ clientIp: '203.0.113.9' });
  });

  it('zählt TRUST_PROXY_HOPS wie das Rate-Limit von rechts', async () => {
    setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: true, TRUST_PROXY_HOPS: 2 });

    const res = GET(request('6.6.6.6, 198.51.100.4, 172.18.0.5'));

    await expect(res.json()).resolves.toStrictEqual({ clientIp: '198.51.100.4' });
  });

  it('meldet null, wenn der Proxy keine gültige Adresse liefert', async () => {
    const missing = GET(request());
    const invalid = GET(request('unknown'));

    await expect(missing.json()).resolves.toStrictEqual({ clientIp: null });
    await expect(invalid.json()).resolves.toStrictEqual({ clientIp: null });
  });

  it('meldet in Produktion ohne Proxy-Zusage immer null, auch mit gesetztem Header', async () => {
    setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: false, TRUST_PROXY_HOPS: 1 });

    const res = GET(request('203.0.113.9'));

    await expect(res.json()).resolves.toStrictEqual({ clientIp: null });
  });
});
