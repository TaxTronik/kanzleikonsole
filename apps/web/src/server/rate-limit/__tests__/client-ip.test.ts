// Fachkatalog: ACCESS-TENANT-RLS-001
// S-03: Client-IP-Ableitung aus X-Forwarded-For. Die Adresse kommt vom
// RECHTEN Ende der Kette (TRUST_PROXY_HOPS-ter Eintrag), nie vom linken, den
// der Client setzen kann; nur syntaktisch gültige IPv4/IPv6-Adressen zählen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  warn: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('@/server/logger', () => ({ log: { warn: h.warn, error: vi.fn() } }));
vi.mock('@/server/redis', () => ({ getRedis: () => null }));

import { clientIpFromForwardedFor, getClientIp, normalizeIpAddress } from '../index';

function setEnv(values: Record<string, unknown>): void {
  for (const key of Object.keys(h.env)) delete h.env[key];
  Object.assign(h.env, values);
}

function forwarded(value: string, extra: Record<string, string> = {}): Headers {
  return new Headers({ 'x-forwarded-for': value, ...extra });
}

beforeEach(() => {
  h.warn.mockReset();
  setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: true, TRUST_PROXY_HOPS: 1 });
});

afterEach(() => setEnv({}));

describe('normalizeIpAddress', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['  203.0.113.7  ', '203.0.113.7'],
    ['203.0.113.7:51234', '203.0.113.7'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0001:0000:0000:0001', '2001:db8::1:0:0:1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['::1', '::1'],
  ])('akzeptiert und kanonisiert %j', (raw, expected) => {
    expect(normalizeIpAddress(raw)).toBe(expected);
  });

  it.each([
    ['::ffff:192.0.2.128', '192.0.2.128'],
    ['::FFFF:C000:0280', '192.0.2.128'],
    ['[::ffff:203.0.113.9]', '203.0.113.9'],
  ])('normalisiert IPv4-mapped IPv6 %j auf IPv4', (raw, expected) => {
    expect(normalizeIpAddress(raw)).toBe(expected);
  });

  it.each([
    '',
    'unknown',
    'localhost',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3',
    '1.2.3.4.5',
    '[1.2.3.4]',
    '[2001:db8::1',
    'fe80::1%eth0',
    '2001:db8::1::2',
    '<script>',
    '203.0.113.7, 198.51.100.1',
    'a'.repeat(80),
  ])('verwirft ungültigen Eintrag %j', (raw) => {
    expect(normalizeIpAddress(raw)).toBeNull();
  });
});

describe('clientIpFromForwardedFor', () => {
  it('nimmt bei einem Hop den rechten Eintrag und ignoriert gefälschte linke Einträge', () => {
    expect(clientIpFromForwardedFor('6.6.6.6, 7.7.7.7, 203.0.113.9', 1)).toBe('203.0.113.9');
  });

  it('überspringt genau die konfigurierten Proxy-Hops', () => {
    const chain = '6.6.6.6, 203.0.113.9, 198.51.100.20, 192.0.2.30';
    expect(clientIpFromForwardedFor(chain, 2)).toBe('198.51.100.20');
    expect(clientIpFromForwardedFor(chain, 3)).toBe('203.0.113.9');
  });

  it('liefert null, wenn die Kette kürzer ist als die vertrauenswürdigen Hops', () => {
    // Request hat nicht alle Proxys passiert: der verbleibende Eintrag kann
    // vom Client stammen.
    expect(clientIpFromForwardedFor('203.0.113.9', 2)).toBeNull();
  });

  it('wertet nur den ausgewählten Eintrag aus, nicht den Client-Teil', () => {
    expect(clientIpFromForwardedFor('kaputt,,<x>, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientIpFromForwardedFor('203.0.113.9, kaputt', 1)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9,', 1)).toBeNull();
  });

  it('liefert null für fehlende Header und unsinnige Hop-Zahlen', () => {
    expect(clientIpFromForwardedFor(null, 1)).toBeNull();
    expect(clientIpFromForwardedFor('', 1)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9', 0)).toBeNull();
    expect(clientIpFromForwardedFor('203.0.113.9', 1.5)).toBeNull();
  });

  it('verarbeitet IPv6-Ketten', () => {
    expect(clientIpFromForwardedFor('2001:db8::dead, 2001:DB8::BEEF', 1)).toBe('2001:db8::beef');
    expect(clientIpFromForwardedFor('::ffff:203.0.113.9', 1)).toBe('203.0.113.9');
  });
});

describe('getClientIp', () => {
  it('liefert in Produktion ohne TRUST_PROXY_REQUIRED nie eine IP', () => {
    setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: false, TRUST_PROXY_HOPS: 1 });
    expect(getClientIp(forwarded('203.0.113.9'))).toBeNull();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('nimmt mit Proxy-Vertrauen den rechten statt des client-kontrollierten linken Eintrags', () => {
    expect(getClientIp(forwarded('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('folgt TRUST_PROXY_HOPS', () => {
    setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: true, TRUST_PROXY_HOPS: 2 });
    expect(getClientIp(forwarded('6.6.6.6, 203.0.113.9, 192.0.2.1'))).toBe('203.0.113.9');
  });

  it('fällt bei fehlendem TRUST_PROXY_HOPS (gemockte ENV) auf einen Hop zurück', () => {
    setEnv({ NODE_ENV: 'production', TRUST_PROXY_REQUIRED: true });
    expect(getClientIp(forwarded('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('wertet X-Real-IP und CF-Connecting-IP nicht aus', () => {
    const spoofed = { 'x-real-ip': '6.6.6.6', 'cf-connecting-ip': '7.7.7.7' };
    expect(getClientIp(forwarded('203.0.113.9', spoofed))).toBe('203.0.113.9');
    expect(getClientIp(new Headers(spoofed))).toBeNull();
  });

  it('liefert für einen ungültigen rechten Eintrag null und warnt in Produktion', () => {
    expect(getClientIp(forwarded('203.0.113.9, unknown'))).toBeNull();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toMatchObject({ trustedHops: 1, forwardedEntries: 2 });
    // Kein Rohwert aus dem Header im Log.
    expect(JSON.stringify(h.warn.mock.calls[0])).not.toContain('203.0.113.9');
  });

  it('normalisiert die von Node gemeldete IPv4-mapped Gegenstelle', () => {
    // Next.js setzt x-forwarded-for selbst auf socket.remoteAddress, wenn der
    // Header fehlt; auf Dual-Stack-Sockets ist das ::ffff:a.b.c.d.
    expect(getClientIp(forwarded('::ffff:198.51.100.4'))).toBe('198.51.100.4');
  });

  it('wertet außerhalb von Produktion ebenfalls nur den rechten Eintrag aus', () => {
    setEnv({ NODE_ENV: 'development', TRUST_PROXY_REQUIRED: false });
    expect(getClientIp(forwarded('6.6.6.6, 127.0.0.1'))).toBe('127.0.0.1');
    expect(getClientIp(new Headers())).toBeNull();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
