// =============================================================================
// Redirect-Ziele hinter dem Reverse-Proxy (Review-Befund B-04).
//
// Im Container bindet der Standalone-Server an HOSTNAME=0.0.0.0. Route-Handler
// sehen dann `req.url` = http://0.0.0.0:3000/…; daraus gebaute absolute
// Locations schickten den Browser an die Bind-Adresse. Alle Redirects der
// Anwendung bleiben deshalb pfadrelativ: Route-Handler über relativeRedirect,
// der Proxy über Nexts eigene Normalisierung gleicher Hosts (hier mit dem
// echten Next-Adapter geprüft). Gegen den gebauten Standalone-Server prüft das
// zusätzlich scripts/ci/check-redirect-locations.mjs im CI-Job e2e-paranoid.
// =============================================================================

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// So sieht ein Route-Handler die Anfrage im Container (HOSTNAME=0.0.0.0).
const BIND_ORIGIN = 'http://0.0.0.0:3000';

const h = vi.hoisted(() => {
  // Wie Nexts Node-Laufzeit (server/node-environment-baseline): vor dem ersten
  // Next-Modul, sonst richtet der Adapter nur einen Platzhalter ein.
  const globals = globalThis as { AsyncLocalStorage?: unknown };
  globals.AsyncLocalStorage ??= process.getBuiltinModule('node:async_hooks').AsyncLocalStorage;
  return {
    checkPassword: vi.fn(),
    completeLogin: vi.fn(),
    issue: vi.fn(),
    expire: vi.fn(),
  };
});

vi.mock('@/app/staff/(auth)/login/actions', () => ({ checkPasswordAction: h.checkPassword }));
vi.mock('@/server/auth/staff-login', () => ({ completeStaffLogin: h.completeLogin }));
vi.mock('@/server/auth/staff-session', () => ({
  staffSessionFactory: { issue: h.issue, expire: h.expire },
  staffSessionToken: (user: unknown) => ({ user }),
}));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '203.0.113.7' }));
vi.mock('@/server/auth/staff', () => ({
  staffSessionSubject: vi.fn(),
  staffSignOut: vi.fn(),
}));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: vi.fn() }));
vi.mock('@taxtronik/config', () => ({ env: { NEXTAUTH_URL: 'https://kanzlei.example.test' } }));

function passwordRequest(query: string, fields: Record<string, string>): NextRequest {
  return new NextRequest(`${BIND_ORIGIN}/staff/login/password${query}`, {
    method: 'POST',
    body: new URLSearchParams(fields),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('relativeRedirect', () => {
  it('setzt nur den Pfad als Location, ohne Cache', async () => {
    const { relativeRedirect } = await import('@/server/http/relative-redirect');
    const response = relativeRedirect('/staff/login?error=x');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/login?error=x');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(relativeRedirect('/portal/login', 307).status).toBe(307);
  });

  it('lehnt Ziele außerhalb der Anwendung ab', async () => {
    const { relativeRedirect } = await import('@/server/http/relative-redirect');
    for (const target of [
      'https://evil.example',
      '//evil.example/x',
      '/\\evil.example',
      'staff/login',
      `${BIND_ORIGIN}/staff/login`,
    ]) {
      expect(() => relativeRedirect(target), target).toThrow(/Pfad der Anwendung/);
    }
  });
});

describe('POST /staff/login/password hinter HOSTNAME=0.0.0.0', () => {
  it('leitet Fehlversuche pfadrelativ auf die Anmeldung zurück', async () => {
    const { POST } = await import('@/app/staff/(auth)/login/password/route');
    h.checkPassword.mockResolvedValue({ ok: false, error: 'x' });
    const failed = await POST(passwordRequest('', { email: 'a@example.test', password: 'p' }));
    expect(failed.status).toBe(303);
    expect(failed.headers.get('location')).toBe('/staff/login?error=password-invalid');

    h.checkPassword.mockResolvedValue({ ok: true, devSkip: false });
    const totp = await POST(passwordRequest('', { email: 'a@example.test', password: 'p' }));
    expect(totp.headers.get('location')).toBe('/staff/login?error=totp-required');

    h.checkPassword.mockResolvedValue({ ok: true, devSkip: true, loginTicket: 't' });
    h.completeLogin.mockResolvedValue(null);
    const invalid = await POST(passwordRequest('', { email: 'a@example.test', password: 'p' }));
    expect(invalid.headers.get('location')).toBe('/staff/login?error=session-invalid');
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('leitet nach der Anmeldung pfadrelativ auf returnTo weiter und stellt das Cookie aus', async () => {
    const { POST } = await import('@/app/staff/(auth)/login/password/route');
    h.checkPassword.mockResolvedValue({ ok: true, devSkip: true, loginTicket: 't' });
    h.completeLogin.mockResolvedValue({ id: 'staff-1' });
    const response = await POST(
      passwordRequest('?returnTo=%2Fstaff%2Fclients%3Ftab%3Dall', {
        email: 'a@example.test',
        password: 'p',
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/clients?tab=all');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.issue).toHaveBeenCalledWith({ user: { id: 'staff-1' } }, expect.anything());
    expect(h.issue.mock.calls[0]![1].response).toBe(response);

    // Unzulässige Ziele fallen wie bisher auf das Dashboard zurück.
    const fallback = await POST(
      passwordRequest('?returnTo=%2F%2Fevil.example', { email: 'a@example.test', password: 'p' }),
    );
    expect(fallback.headers.get('location')).toBe('/staff/dashboard');
  });
});

describe('GET /api/staff/force-logout hinter HOSTNAME=0.0.0.0', () => {
  it('leitet pfadrelativ auf die Anmeldung', async () => {
    const { GET } = await import('@/app/api/staff/force-logout/route');
    const response = await GET(new NextRequest(`${BIND_ORIGIN}/api/staff/force-logout`));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/staff/login');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.expire).toHaveBeenCalledTimes(1);
  });
});

describe('Proxy-Redirects hinter HOSTNAME=0.0.0.0', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  async function throughNextAdapter(url: string, headers: Record<string, string> = {}) {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      NEXTAUTH_URL: 'https://kanzlei.example.test',
      PORTAL_PUBLIC_URL: undefined,
    };
    vi.resetModules();
    const { proxy } = await import('../proxy');
    const { adapter } = await import('next/dist/server/web/adapter');
    const result = await adapter({
      handler: async (request) => proxy(request as unknown as NextRequest),
      page: '/proxy',
      request: {
        url,
        method: 'GET',
        headers,
        nextConfig: { basePath: '', trailingSlash: false },
        signal: new AbortController().signal,
      },
    });
    return result.response;
  }

  it('macht die Weiterleitung zur Anmeldung relativ (Next-Adapter wie im Server)', async () => {
    const staff = await throughNextAdapter(`${BIND_ORIGIN}/staff/dashboard`, {
      host: 'kanzlei.example.test',
    });
    expect(staff.status).toBe(307);
    expect(staff.headers.get('location')).toBe('/staff/login?returnTo=%2Fstaff%2Fdashboard');

    const portal = await throughNextAdapter(`${BIND_ORIGIN}/portal/documents`);
    expect(portal.headers.get('location')).toBe('/portal/login?returnTo=%2Fportal%2Fdocuments');
  });
});
