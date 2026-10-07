// Fachkatalog: ACCESS-TENANT-RLS-001
// B5 (S-05): Die Auth.js-Catch-all-Routen reichen nur noch die genutzten
// Aktionen weiter (Staff: csrf, signout, callback/credentials,
// callback/hardware-key; Portal: csrf, signout). Jede andere Aktion antwortet
// 404, eine erlaubte Aktion mit anderer Methode 405 — beides, ohne Auth.js
// aufzurufen. Der zweite Teil schickt dieselben Anfragen an echtes Auth.js
// (@auth/core Auth() mit der echten Staff-/Portal-Konfiguration, wie der
// next-auth-Route-Handler; next-auth selbst ist unter Vitest nicht ladbar).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '@auth/core';
import { NextRequest } from 'next/server';
import type { NextAuthConfig } from 'next-auth';

type Surface = 'staff' | 'portal';

const h = vi.hoisted(() => ({
  configs: {} as Record<'staff' | 'portal', NextAuthConfig>,
  delegate: {} as Record<'staff' | 'portal', ReturnType<typeof vi.fn>>,
  completeStaffLogin: vi.fn(),
}));

vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock('next-auth', () => ({
  default: (config: NextAuthConfig) => {
    const surface: Surface = config.basePath === '/api/auth/staff' ? 'staff' : 'portal';
    h.configs[surface] = config;
    // Steht für den Auth.js-Handler: jede Weitergabe ist so sichtbar.
    const delegate = vi.fn(
      async (_request: Request) => new Response('{}', { headers: { 'x-delegated': surface } }),
    );
    h.delegate[surface] = delegate;
    return { handlers: { GET: delegate, POST: delegate }, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'x'.repeat(40),
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXTAUTH_TRUST_HOST: true,
    NODE_ENV: 'test',
  },
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/redis', () => ({ getRedis: () => null }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => null,
  checkIpOrGlobalLimit: vi.fn(async () => ({ ok: true })),
  resetRateLimit: vi.fn(),
}));
vi.mock('../revocation', () => ({ isTokenRevoked: vi.fn(async () => false) }));
vi.mock('../webauthn', () => ({ authenticateStaffHardwareCredential: vi.fn(async () => null) }));
vi.mock('../staff-login', () => ({
  completeStaffLogin: h.completeStaffLogin,
  DEV_SKIP_TOTP: false,
}));

import { restrictAuthJsRoute, type AuthJsRouteHandlers } from '../authjs-route';
import { STAFF_AUTHJS_ROUTE, staffHandlers } from '../staff';
import { PORTAL_AUTHJS_ROUTE, portalHandlers } from '../portal';
import * as staffRoute from '@/app/api/auth/staff/[...nextauth]/route';
import * as portalRoute from '@/app/api/auth/portal/[...nextauth]/route';

const ORIGIN = 'http://localhost:3000';
const STAFF = '/api/auth/staff';
const PORTAL = '/api/auth/portal';

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function request(method: string, path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { method, ...init });
}

/** Wie Next.js: HEAD läuft über den GET-Export, alles außer GET/HEAD hier über POST. */
function send(
  handlers: AuthJsRouteHandlers<NextRequest>,
  method: string,
  path: string,
  init: NextRequestInit = {},
): Promise<Response> {
  const exported = method === 'GET' || method === 'HEAD' ? handlers.GET : handlers.POST;
  return exported(request(method, path, init));
}

type Expectation = 'delegiert' | 404 | readonly [405, string];

const STAFF_CASES: ReadonlyArray<readonly [string, string, Expectation]> = [
  ['GET', `${STAFF}/csrf`, 'delegiert'],
  ['GET', `${STAFF}/csrf?callbackUrl=%2Fstaff%2Fdashboard`, 'delegiert'],
  ['POST', `${STAFF}/signout`, 'delegiert'],
  ['POST', `${STAFF}/callback/credentials`, 'delegiert'],
  ['POST', `${STAFF}/callback/hardware-key`, 'delegiert'],
  ['GET', `${STAFF}/session`, 404],
  ['POST', `${STAFF}/session`, 404],
  ['GET', `${STAFF}/signin`, 404],
  ['POST', `${STAFF}/signin`, 404],
  ['GET', `${STAFF}/signin/credentials`, 404],
  ['POST', `${STAFF}/signin/hardware-key`, 404],
  ['GET', `${STAFF}/providers`, 404],
  ['GET', `${STAFF}/error?error=Configuration`, 404],
  ['GET', `${STAFF}/verify-request`, 404],
  ['GET', `${STAFF}/webauthn-options/hardware-key`, 404],
  ['POST', `${STAFF}/callback`, 404],
  ['POST', `${STAFF}/callback/unbekannt`, 404],
  ['POST', `${STAFF}/callback/undefined`, 404],
  ['POST', `${STAFF}/callback/credentials/zusatz`, 404],
  ['GET', `${STAFF}/CSRF`, 404],
  ['GET', `${STAFF}/c%73rf`, 404],
  ['GET', `${STAFF}/`, 404],
  ['GET', `${PORTAL}/csrf`, 404],
  ['GET', `${STAFF}/signout`, [405, 'POST']],
  ['POST', `${STAFF}/csrf`, [405, 'GET']],
  ['GET', `${STAFF}/callback/credentials`, [405, 'POST']],
  ['HEAD', `${STAFF}/csrf`, [405, 'GET']],
  ['PUT', `${STAFF}/signout`, [405, 'POST']],
];

const PORTAL_CASES: ReadonlyArray<readonly [string, string, Expectation]> = [
  ['GET', `${PORTAL}/csrf`, 'delegiert'],
  ['POST', `${PORTAL}/signout`, 'delegiert'],
  // Der frühere zweite Login-Pfad (S-05) erreicht Auth.js nicht mehr.
  ['POST', `${PORTAL}/callback/credentials`, 404],
  ['GET', `${PORTAL}/session`, 404],
  ['POST', `${PORTAL}/session`, 404],
  ['GET', `${PORTAL}/signin`, 404],
  ['GET', `${PORTAL}/providers`, 404],
  ['GET', `${PORTAL}/error`, 404],
  ['GET', `${PORTAL}/verify-request`, 404],
  ['GET', `${STAFF}/csrf`, 404],
  ['GET', `${PORTAL}/signout`, [405, 'POST']],
  ['POST', `${PORTAL}/csrf`, [405, 'GET']],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['staff', () => staffHandlers, STAFF_CASES],
  ['portal', () => portalHandlers, PORTAL_CASES],
] as const)('B5: Auth.js-Route %s', (surface, handlers, cases) => {
  it.each(cases)('%s %s → %j', async (method, path, expected) => {
    const response = await send(handlers(), method, path);
    const delegate = h.delegate[surface];

    if (expected === 'delegiert') {
      expect(delegate).toHaveBeenCalledOnce();
      const forwarded = delegate.mock.calls[0]![0] as Request;
      expect([forwarded.method, new URL(forwarded.url).pathname]).toEqual([
        method,
        new URL(path, ORIGIN).pathname,
      ]);
      expect(response.headers.get('x-delegated')).toBe(surface);
      return;
    }
    expect(delegate).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    if (expected === 404) {
      expect(response.status).toBe(404);
      expect(response.headers.has('allow')).toBe(false);
    } else {
      expect([response.status, response.headers.get('allow')]).toEqual(expected);
    }
  });

  it('die Route exportiert genau die beschränkten Handler', () => {
    const route = surface === 'staff' ? staffRoute : portalRoute;
    expect(route.GET).toBe(handlers().GET);
    expect(route.POST).toBe(handlers().POST);
  });
});

describe('B5: Liste und Konfiguration passen zusammen', () => {
  it('erlaubt genau die Callbacks der konfigurierten Staff-Provider, im Portal keinen', () => {
    const configured = (h.configs.staff.providers ?? []).map((entry) => {
      const provider = (typeof entry === 'function' ? entry() : entry) as {
        id: string;
        options?: { id?: string };
      };
      return provider.options?.id ?? provider.id;
    });
    const callbacks = (spec: typeof STAFF_AUTHJS_ROUTE) =>
      spec.endpoints
        .filter((endpoint) => endpoint.action === 'callback')
        .map((endpoint) => endpoint.providerId);

    expect(configured.sort()).toEqual(['credentials', 'hardware-key']);
    expect(callbacks(STAFF_AUTHJS_ROUTE).sort()).toEqual(configured);
    expect(h.configs.portal.providers).toEqual([]);
    expect(callbacks(PORTAL_AUTHJS_ROUTE)).toEqual([]);
    expect(STAFF_AUTHJS_ROUTE.basePath).toBe(h.configs.staff.basePath);
    expect(PORTAL_AUTHJS_ROUTE.basePath).toBe(h.configs.portal.basePath);
  });

  it('leitet Fehler der verbleibenden Endpunkte auf die Anmeldung statt auf die gesperrte Fehlerseite', () => {
    expect(h.configs.staff.pages).toEqual({ signIn: '/staff/login', error: '/staff/login' });
    expect(h.configs.portal.pages).toEqual({ signIn: '/portal/login', error: '/portal/login' });
  });
});

describe('B5: mit echtem Auth.js und der echten Oberflächen-Konfiguration', () => {
  async function authJs(surface: Surface) {
    const config: NextAuthConfig = {
      ...h.configs[surface],
      logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    const handler = (request: NextRequest) => Auth(request, config);
    const raw: AuthJsRouteHandlers<NextRequest> = { GET: handler, POST: handler };
    const spec = surface === 'staff' ? STAFF_AUTHJS_ROUTE : PORTAL_AUTHJS_ROUTE;
    return { raw, restricted: restrictAuthJsRoute(raw, spec) };
  }

  async function csrfPair(
    handlers: AuthJsRouteHandlers<NextRequest>,
    base: string,
  ): Promise<{ token: string; cookie: string }> {
    const response = await send(handlers, 'GET', `${base}/csrf`);
    expect(response.status).toBe(200);
    const { csrfToken } = (await response.json()) as { csrfToken: string };
    const cookie = response.headers
      .getSetCookie()
      .find((value) => /^(?:__Host-)?authjs\.csrf-token=/.test(value))!
      .split(';')[0]!;
    return { token: csrfToken, cookie };
  }

  function form(pair: { token: string; cookie: string }, fields: Record<string, string> = {}) {
    return {
      headers: {
        cookie: pair.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrfToken: pair.token, ...fields }),
    };
  }

  function redirectTarget(response: Response): string {
    const url = new URL(response.headers.get('location')!);
    return `${url.pathname}${url.search}`;
  }

  it.each(['staff', 'portal'] as const)(
    '%s: Auth.js bedient session, providers und signin, die Route antwortet 404',
    async (surface) => {
      const { raw, restricted } = await authJs(surface);
      const base = surface === 'staff' ? STAFF : PORTAL;
      // signin leitet wegen pages.signIn auf die eigene Anmeldeseite um.
      for (const [action, status] of [
        ['session', 200],
        ['providers', 200],
        ['signin', 302],
      ] as const) {
        expect((await send(raw, 'GET', `${base}/${action}`)).status).toBe(status);
        expect((await send(restricted, 'GET', `${base}/${action}`)).status).toBe(404);
      }
    },
  );

  it('staff: Credentials-Callback mit CSRF-Paar erreicht authorize; Fehler leiten zur Anmeldung', async () => {
    const { restricted } = await authJs('staff');
    const pair = await csrfPair(restricted, STAFF);

    h.completeStaffLogin.mockResolvedValueOnce(null);
    const rejected = await send(
      restricted,
      'POST',
      `${STAFF}/callback/credentials`,
      form(pair, { loginTicket: 'ticket-1', totpCode: '123456' }),
    );
    expect(h.completeStaffLogin).toHaveBeenCalledWith({
      loginTicket: 'ticket-1',
      totpCode: '123456',
      ip: null,
    });
    expect(rejected.status).toBe(302);
    expect(redirectTarget(rejected)).toBe('/staff/login?error=CredentialsSignin&code=credentials');

    // authorize wirft: früher Umleitung auf /api/auth/staff/error (jetzt 404).
    h.completeStaffLogin.mockRejectedValueOnce(new Error('Datenbank nicht erreichbar'));
    const failed = await send(
      restricted,
      'POST',
      `${STAFF}/callback/credentials`,
      form(pair, { loginTicket: 'ticket-2', totpCode: '123456' }),
    );
    expect(failed.status).toBe(302);
    expect(redirectTarget(failed)).toBe('/staff/login?error=Configuration');
  });

  it.each(['staff', 'portal'] as const)(
    '%s: Abmelden mit CSRF-Paar löscht das Session-Cookie',
    async (surface) => {
      const { restricted } = await authJs(surface);
      const base = surface === 'staff' ? STAFF : PORTAL;
      const pair = await csrfPair(restricted, base);
      const sessionCookie = `__taxtronik_${surface}_session`;

      const response = await send(restricted, 'POST', `${base}/signout`, {
        ...form(pair),
        headers: { ...form(pair).headers, cookie: `${pair.cookie}; ${sessionCookie}=abgelaufen` },
      });

      expect(response.status).toBe(302);
      expect(
        response.headers
          .getSetCookie()
          .some((value) => value.startsWith(`${sessionCookie}=;`) && /Max-Age=0/i.test(value)),
      ).toBe(true);
    },
  );

  it('portal: der Credentials-Callback erreicht Auth.js nicht mehr (zuvor Konfigurationsfehler)', async () => {
    const { raw, restricted } = await authJs('portal');
    const pair = await csrfPair(restricted, PORTAL);
    const body = () => form(pair, { token: 'a'.repeat(43) });

    const unrestricted = await send(raw, 'POST', `${PORTAL}/callback/credentials`, body());
    expect(unrestricted.status).toBe(302);
    expect(redirectTarget(unrestricted)).toBe('/portal/login?error=Configuration');

    const response = await send(restricted, 'POST', `${PORTAL}/callback/credentials`, body());
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
