// Fachkatalog: ACCESS-TENANT-RLS-001, CLIENT-MANDATE-LIFECYCLE-001.
// Exercise the real Auth.js HTTP session action and JWT codec across renewal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '@auth/core';
import type { NextAuthConfig } from 'next-auth';
import type { JWT } from 'next-auth/jwt';

const h = vi.hoisted(() => ({
  configs: {} as Record<'staff' | 'portal', NextAuthConfig>,
  cookie: '',
  cutoff: null as string | null,
  redisFailure: false,
  accountActive: true,
  dbFailure: false,
  authRevision: 0,
  mandateEndedAt: null as Date | null,
}));
vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: h.cookie }), getAll: () => [] }),
}));
vi.mock('next-auth', () => ({
  default: (config: NextAuthConfig) => {
    h.configs[config.basePath?.endsWith('staff') ? 'staff' : 'portal'] = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'session-renewal-local-fixture-secret-32chars',
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXTAUTH_TRUST_HOST: true,
    NODE_ENV: 'test',
  },
}));
vi.mock('../magic-link', () => ({ verifyMagicLink: vi.fn() }));
vi.mock('../totp', () => ({ decryptTotpSecret: vi.fn(), verifyTotpCode: vi.fn() }));
vi.mock('../lockout', () => ({ resetFailedLogin: vi.fn() }));
vi.mock('../login-audit', () => ({ recordFailedLoginAudited: vi.fn(), auditIp: vi.fn() }));
vi.mock('../totp-replay', () => ({ consumeTotpCode: vi.fn() }));
vi.mock('../webauthn', () => ({ authenticateStaffHardwareCredential: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: vi.fn(),
  checkIpOrGlobalLimit: vi.fn(),
  checkStaffPasswordAccountLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  staffPasswordAccountRateLimitKey: vi.fn(),
}));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    get: async () => {
      if (h.redisFailure) throw new Error('fixture Redis unavailable');
      return h.cutoff;
    },
  }),
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    staffUser: {
      findUnique: async () => {
        if (h.dbFailure) throw new Error('fixture DB unavailable');
        return {
          active: h.accountActive,
          tenantId: 'tenant',
          authRevision: h.authRevision,
          hardwareOnlyEnabledAt: null,
          roles: [{ role: 'EMPLOYEE' }],
          permissions: [],
        };
      },
    },
    clientContact: {
      findUnique: async () => {
        if (h.dbFailure) throw new Error('fixture DB unavailable');
        return {
          active: h.accountActive,
          tenantId: 'tenant',
          clientId: 'client',
          email: 'contact@example.test',
          client: { allowActive: true, anonymizedAt: null, mandateEndedAt: h.mandateEndedAt },
        };
      },
    },
  },
}));

import { staffAuth } from '../staff';
import { portalAuth } from '../portal';

const NOW = new Date('2026-09-06T12:00:00Z');
type Surface = 'staff' | 'portal';
const readSession = { staff: staffAuth, portal: portalAuth };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.cutoff = null;
  h.redisFailure = false;
  h.dbFailure = false;
  h.accountActive = true;
  h.authRevision = 0;
  h.mandateEndedAt = null;
  h.cookie = '';
});
afterEach(() => vi.useRealTimers());

async function issueCookie(surface: Surface, extra: JWT = {}, ageMs = 60_000) {
  const config = h.configs[surface];
  vi.setSystemTime(new Date(NOW.getTime() - ageMs));
  h.cookie = await config.jwt!.encode!({
    secret: config.secret!,
    salt: config.cookies!.sessionToken!.name!,
    maxAge: 86_400,
    token: {
      sessionIssuedAt: Math.floor(Date.now() / 1000),
      sub: surface,
      tenantId: 'tenant',
      fullName: 'Fixture',
      ...(surface === 'staff'
        ? {
            staffId: 'staff',
            roles: ['EMPLOYEE'],
            permissions: [],
            authMethod: 'totp',
            authRevision: 0,
          }
        : { contactId: 'contact', clientId: 'client', email: 'contact@example.test' }),
      ...extra,
    },
  });
  vi.setSystemTime(NOW);
}

async function renew(surface: Surface) {
  const config = h.configs[surface];
  const name = config.cookies!.sessionToken!.name!;
  const response = await Auth(
    new Request(`http://localhost:3000${config.basePath}/session`, {
      headers: { cookie: `${name}=${h.cookie}` },
    }),
    {
      ...config,
      providers: [],
      trustHost: true,
      logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
  );
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (cookie) h.cookie = cookie.split(';')[0]!.slice(name.length + 1);
  return response.json();
}

describe.each<Surface>(['portal', 'staff'])('%s session renewal', (surface) => {
  it('deletes a revoked unexpired cookie instead of renewing it', async () => {
    await issueCookie(surface);
    h.cutoff = String(NOW.getTime() - 30_000);
    expect(await readSession[surface]()).toBeNull();
    expect(await renew(surface)).toBeNull();
    expect(h.cookie).toBe('');
    expect(await readSession[surface]()).toBeNull();
  });

  it('preserves the initial issue time when a healthy cookie is renewed', async () => {
    await issueCookie(surface);
    expect(await renew(surface)).not.toBeNull();
    h.cutoff = String(NOW.getTime() - 30_000);
    expect(await readSession[surface]()).toBeNull();
    expect(await renew(surface)).toBeNull();
  });

  it('retains a valid session across repeated refreshes', async () => {
    await issueCookie(surface);
    expect(await renew(surface)).not.toBeNull();
    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    expect(await renew(surface)).not.toBeNull();
    expect(await readSession[surface]()).not.toBeNull();
  });

  it.each([null, String(NOW.getTime() - 120_000)])(
    'requires a new login for legacy cookies even when iat follows the cutoff %s',
    async (cutoff) => {
      await issueCookie(surface, { sessionIssuedAt: undefined });
      h.cutoff = cutoff;
      expect(await readSession[surface]()).toBeNull();
      expect(await renew(surface)).toBeNull();
      expect(h.cookie).toBe('');
    },
  );

  it('does not issue a replacement when Redis cannot establish the current state', async () => {
    await issueCookie(surface);
    h.redisFailure = true;
    expect(await renew(surface)).toBeNull();
    expect(h.cookie).toBe('');
  });

  it.each(['inactive', 'database'] as const)(
    'does not renew an %s account state',
    async (reason) => {
      await issueCookie(surface);
      h.accountActive = reason !== 'inactive';
      h.dbFailure = reason === 'database';
      expect(await renew(surface)).toBeNull();
      expect(h.cookie).toBe('');
    },
  );

  it('rejects malformed original issue times without falling back to a newer iat', async () => {
    await issueCookie(surface, { sessionIssuedAt: 'invalid' });
    expect(await renew(surface)).toBeNull();
  });

  it('clears expired cookies', async () => {
    await issueCookie(surface, {}, 2 * 86_400_000);
    expect(await renew(surface)).toBeNull();
    expect(h.cookie).toBe('');
  });
});

it('does not renew a staff cookie with an obsolete authentication revision', async () => {
  await issueCookie('staff');
  h.authRevision = 1;
  expect(await renew('staff')).toBeNull();
});

it('does not renew a portal cookie after mandate termination', async () => {
  await issueCookie('portal');
  h.mandateEndedAt = new Date(NOW.getTime() - 30_000);
  expect(await renew('portal')).toBeNull();
});
