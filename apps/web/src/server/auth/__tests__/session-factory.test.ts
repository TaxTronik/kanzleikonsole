// Fachkatalog: ACCESS-TENANT-RLS-001
// S-05: eine Session-Fabrik je Oberfläche. Echter Auth.js-JWT-Codec und echte
// Auth.js-HTTP-Verarbeitung; nur Cookie-Jar, DB und Redis sind ersetzt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '@auth/core';
import type { NextAuthConfig } from 'next-auth';
import type { JWT } from 'next-auth/jwt';

type Written = { name: string; value: string; options: Record<string, unknown> };

function cookieJar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Written[] = [];
  return {
    values,
    writes,
    get: (name: string) => (values.has(name) ? { name, value: values.get(name)! } : undefined),
    getAll: () => [...values].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, cookieOptions: object) => {
      const options = cookieOptions as Record<string, unknown>;
      writes.push({ name, value, options });
      if (options['maxAge'] === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

const h = vi.hoisted(() => ({
  jar: null as unknown as ReturnType<typeof cookieJar>,
  portalConfig: null as unknown as NextAuthConfig,
  verifyMagicLink: vi.fn(),
}));

vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({ cookies: async () => h.jar }));
vi.mock('next-auth', () => ({
  default: (config: NextAuthConfig) => {
    h.portalConfig = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'session-factory-fixture-secret-with-32-chars',
    NEXTAUTH_URL: 'https://kanzlei.example.test',
    NEXTAUTH_TRUST_HOST: true,
    NODE_ENV: 'test',
  },
}));
vi.mock('../magic-link', () => ({ verifyMagicLink: h.verifyMagicLink }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/redis', () => ({ getRedis: () => null }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  createSessionFactory,
  SessionLifetimeExceededError,
  type SessionFactorySpec,
} from '../session-factory';

const SECRET = 'session-factory-fixture-secret-with-32-chars';
const NOW = new Date('2026-10-05T10:00:00Z');
const nowSec = () => Math.floor(Date.now() / 1000);

function factory(overrides: Partial<SessionFactorySpec> = {}) {
  return createSessionFactory({
    cookieName: '__Host-fixture_session',
    cookieBase: 'fixture_session',
    secure: true,
    domain: undefined,
    jwtSalt: 'fixture_session:https://kanzlei.example.test',
    jwtDecodeSalts: ['fixture_session:https://kanzlei.example.test', 'fixture_session'],
    secret: SECRET,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.jar = cookieJar();
  h.verifyMagicLink.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('S-05: Session-Fabrik', () => {
  it('stellt das Cookie mit den Auth.js-Optionen aus und liest es mit demselben Codec', async () => {
    const sessions = factory();
    await sessions.issue({ sub: 'staff-1', staffId: 'staff-1', sessionIssuedAt: nowSec() });

    expect(h.jar.writes).toEqual([
      {
        name: '__Host-fixture_session',
        value: expect.any(String),
        options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 86_400 },
      },
    ]);
    expect(sessions.authJs.cookies.sessionToken).toEqual({
      name: '__Host-fixture_session',
      options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    });
    // Kein updateAge: Auth.js wertet es für JWT-Sessions nicht aus.
    expect(sessions.authJs.session).toEqual({ strategy: 'jwt', maxAge: 86_400 });

    const token = await sessions.read();
    expect(token).toMatchObject({ sub: 'staff-1', staffId: 'staff-1' });
    expect(token!.exp! - token!.iat!).toBe(86_400);
    await expect(
      sessions.authJs.jwt.decode({
        token: h.jar.values.get('__Host-fixture_session'),
        secret: SECRET,
        salt: '__Host-fixture_session',
      }),
    ).resolves.toMatchObject({ sub: 'staff-1' });
    // Lesen erneuert nichts.
    expect(h.jar.writes).toHaveLength(1);
  });

  it('akzeptiert mit Secure-Cookies nur den konfigurierten Namen, lokal weiter alle Varianten', async () => {
    const strict = factory();
    await strict.issue({ sub: 'staff-1', sessionIssuedAt: nowSec() });
    const value = h.jar.values.get('__Host-fixture_session')!;
    const local = factory({ cookieName: '__fixture_session', secure: false });

    for (const name of ['__fixture_session', '__Secure-fixture_session']) {
      await expect(strict.read(cookieJar({ [name]: value }))).resolves.toBeNull();
      await expect(local.read(cookieJar({ [name]: value }))).resolves.toMatchObject({
        sub: 'staff-1',
      });
    }
    await expect(
      strict.read(cookieJar({ '__Host-fixture_session': value })),
    ).resolves.toMatchObject({ sub: 'staff-1' });
  });

  it('begrenzt jede Ausstellung auf Anmeldung + 24 h', async () => {
    const sessions = factory();
    const loginAt = nowSec() - 23 * 3_600;
    await sessions.issue({ sub: 'staff-1', sessionIssuedAt: loginAt });
    expect(h.jar.writes[0]!.options['maxAge']).toBe(3_600);
    await expect(sessions.read()).resolves.toMatchObject({ exp: loginAt + 86_400 });

    // Auch der Auth.js-Codec (Erneuerung über /session) verlängert nicht.
    const renewed = await sessions.authJs.jwt.encode({
      token: { sub: 'staff-1', sessionIssuedAt: loginAt, exp: nowSec() + 60 },
      secret: SECRET,
      salt: '__Host-fixture_session',
      maxAge: 86_400,
    });
    await expect(
      sessions.authJs.jwt.decode({
        token: renewed,
        secret: SECRET,
        salt: '__Host-fixture_session',
      }),
    ).resolves.toMatchObject({ exp: loginAt + 86_400 });
  });

  it('verlängert Altbestand ohne Anmeldeanker nie über seinen bisherigen Ablauf', async () => {
    const sessions = factory();
    const exp = nowSec() + 600;
    const value = await sessions.authJs.jwt.encode({
      token: { sub: 'legacy', exp },
      secret: SECRET,
      salt: '__Host-fixture_session',
      maxAge: 86_400,
    });
    await expect(
      sessions.authJs.jwt.decode({ token: value, secret: SECRET, salt: '__Host-fixture_session' }),
    ).resolves.toMatchObject({ sub: 'legacy', exp });
    expect(sessions.isLive({ sub: 'legacy', exp })).toBe(true);
  });

  it('stellt ohne Anmeldeanker oder nach 24 h nichts mehr aus', async () => {
    const sessions = factory();
    await expect(sessions.issue({ sub: 'staff-1' })).rejects.toThrow(SessionLifetimeExceededError);
    await expect(
      sessions.issue({ sub: 'staff-1', sessionIssuedAt: nowSec() - 86_400 }),
    ).rejects.toThrow(SessionLifetimeExceededError);
    expect(h.jar.writes).toEqual([]);
  });

  it('lehnt ein früher gleitend verlängertes Token 24 h nach der Anmeldung ab', () => {
    const sessions = factory();
    const loginAt = nowSec() - 86_400 - 1;
    const extended = { sub: 'staff-1', sessionIssuedAt: loginAt, exp: nowSec() + 3_600 };
    expect(sessions.isLive(extended)).toBe(false);
    expect(sessions.expiresAt(extended)).toBe(new Date((loginAt + 86_400) * 1000).toISOString());
  });

  it('verwirft Tokens nach Ablauf ihrer 24 h', async () => {
    const sessions = factory();
    await sessions.issue({ sub: 'staff-1', sessionIssuedAt: nowSec() });
    vi.setSystemTime(new Date(NOW.getTime() + 86_400_000 + 1_000));
    await expect(sessions.read()).resolves.toBeNull();
  });

  it('setzt die Cookie-Domain nie an __Host-Namen', async () => {
    const sessions = factory({
      cookieName: '__Secure-fixture_session',
      domain: 'kanzlei.example.test',
    });
    await sessions.issue({ sub: 'staff-1', sessionIssuedAt: nowSec() });
    expect(h.jar.writes[0]).toMatchObject({
      name: '__Secure-fixture_session',
      options: { domain: 'kanzlei.example.test', secure: true },
    });

    const response = cookieJar();
    sessions.expire({ cookies: cookieJar() }, { cookies: response });
    const options = Object.fromEntries(response.writes.map((w) => [w.name, w.options]));
    expect(options['__Host-fixture_session']).not.toHaveProperty('domain');
    expect(options['__Secure-fixture_session']).toMatchObject({ domain: 'kanzlei.example.test' });
  });

  it('teilt übergroße Tokens wie Auth.js auf und entfernt das alte direkte Cookie', async () => {
    const sessions = factory();
    h.jar = cookieJar({ '__Host-fixture_session': 'old-direct-token' });
    await sessions.issue({ sub: 'staff-1', sessionIssuedAt: nowSec(), filler: 'x'.repeat(6_000) });

    expect([...h.jar.values.keys()].sort()).toEqual([
      '__Host-fixture_session.0',
      '__Host-fixture_session.1',
      '__Host-fixture_session.2',
    ]);
    await expect(sessions.read()).resolves.toMatchObject({ sub: 'staff-1' });

    // Zurück auf ein kleines Token: verwaiste Chunks verschwinden.
    await sessions.issue({ sub: 'staff-2', sessionIssuedAt: nowSec() });
    expect([...h.jar.values.keys()]).toEqual(['__Host-fixture_session']);
    await expect(sessions.read()).resolves.toMatchObject({ sub: 'staff-2' });
  });

  it('stellt im Route-Handler auf die Response aus und räumt anhand der Request-Cookies auf', async () => {
    const sessions = factory();
    const request = cookieJar({
      '__Host-fixture_session.0': 'stale',
      '__Host-fixture_session.1': 'x',
    });
    const response = cookieJar();
    await sessions.issue(
      { sub: 'staff-1', sessionIssuedAt: nowSec() },
      {
        request: { cookies: request },
        response: { cookies: response },
      },
    );
    expect(response.writes.map((w) => [w.name, w.options['maxAge']])).toEqual([
      ['__Host-fixture_session', 86_400],
      ['__Host-fixture_session.0', 0],
      ['__Host-fixture_session.1', 0],
    ]);
    expect(h.jar.writes).toEqual([]);
  });

  it('löscht beim Logout alle Varianten samt Chunks und erkennt nur echte Session-Namen', () => {
    const sessions = factory({ secure: false, cookieName: '__fixture_session' });
    const request = cookieJar({
      '__Host-fixture_session.0': 'a',
      '__Host-fixture_session.1': 'b',
      __fixture_session_other: 'kein Session-Cookie',
    });
    const response = cookieJar();
    sessions.expire({ cookies: request }, { cookies: response });

    expect(response.writes.map((w) => w.name).sort()).toEqual([
      '__Host-fixture_session',
      '__Host-fixture_session.0',
      '__Host-fixture_session.1',
      '__Secure-fixture_session',
      '__fixture_session',
    ]);
    for (const write of response.writes) {
      expect(write.value).toBe('');
      expect(write.options).toMatchObject({ maxAge: 0, path: '/', httpOnly: true });
      expect(write.options['secure']).toBe(write.name !== '__fixture_session');
    }
    expect(sessions.hasCookie(request)).toBe(true);
    expect(sessions.hasCookie(cookieJar({ __fixture_session_other: 'x' }))).toBe(false);
  });
});

describe('S-05: Production akzeptiert serverseitig nur die konfigurierten Namen', () => {
  async function load(nodeEnv: 'production' | 'test') {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('CI', 'false');
    vi.stubEnv('STAFF_COOKIE_DOMAIN', '');
    vi.stubEnv('PORTAL_COOKIE_DOMAIN', '');
    vi.resetModules();
    const { staffSessionFactory } = await import('../staff-session');
    const { portalSessionFactory } = await import('../portal-session');
    const names = await import('../session-cookie');
    return { staffSessionFactory, portalSessionFactory, names };
  }

  it.each(['staff', 'portal'] as const)('%s: gleiche Regel wie der Proxy', async (surface) => {
    const production = await load('production');
    const sessions =
      surface === 'staff' ? production.staffSessionFactory : production.portalSessionFactory;
    const configured = `__Host-taxtronik_${surface}_session`;
    expect(sessions.cookieName).toBe(configured);
    expect(
      production.names.acceptedSessionCookieNames(configured, `taxtronik_${surface}_session`, true),
    ).toEqual([configured]);

    await sessions.issue({ sub: 'user-1', sessionIssuedAt: nowSec() });
    const value = h.jar.values.get(configured)!;
    for (const name of [
      `__taxtronik_${surface}_session`,
      `__Secure-taxtronik_${surface}_session`,
    ]) {
      await expect(sessions.read(cookieJar({ [name]: value }))).resolves.toBeNull();
    }
    await expect(sessions.read(cookieJar({ [configured]: value }))).resolves.toMatchObject({
      sub: 'user-1',
    });

    // Dev/Test bleibt präfix-tolerant (lokales HTTP).
    const development = await load('test');
    const devSessions =
      surface === 'staff' ? development.staffSessionFactory : development.portalSessionFactory;
    h.jar = cookieJar();
    await devSessions.issue({ sub: 'user-1', sessionIssuedAt: nowSec() });
    const devValue = h.jar.values.get(`__taxtronik_${surface}_session`)!;
    for (const name of [
      `__taxtronik_${surface}_session`,
      `__Host-taxtronik_${surface}_session`,
      `__Secure-taxtronik_${surface}_session`,
    ]) {
      await expect(devSessions.read(cookieJar({ [name]: devValue }))).resolves.toMatchObject({
        sub: 'user-1',
      });
    }
  });
});

describe('S-05: Portal-Auth.js stellt keine Session mehr aus', () => {
  it('hat keinen Provider; der öffentliche Credentials-Callback scheitert trotz gültigem CSRF-Paar', async () => {
    vi.resetModules();
    await import('../portal');
    const config: NextAuthConfig = {
      ...h.portalConfig,
      trustHost: true,
      logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    expect(config.providers).toEqual([]);

    const base = 'http://localhost:3000/api/auth/portal';
    const csrf = await Auth(new Request(`${base}/csrf`), config);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const csrfCookie = csrf.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('authjs.csrf-token='))!
      .split(';')[0]!;

    const response = await Auth(
      new Request(`${base}/callback/credentials`, {
        method: 'POST',
        headers: {
          cookie: csrfCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrfToken, token: 'a'.repeat(43) }),
      }),
      config,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=Configuration');
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.includes('taxtronik_portal_session')),
    ).toBe(false);
    expect(h.verifyMagicLink).not.toHaveBeenCalled();
  });

  it('verwirft im JWT-Callback jeden direkt angemeldeten Benutzer', async () => {
    vi.resetModules();
    await import('../portal');
    const jwt = h.portalConfig.callbacks!.jwt!;
    await expect(
      jwt({
        token: { sub: 'contact-1' } as JWT,
        user: { id: 'contact-1' },
        account: null,
      } as Parameters<typeof jwt>[0]),
    ).resolves.toBeNull();
  });
});
