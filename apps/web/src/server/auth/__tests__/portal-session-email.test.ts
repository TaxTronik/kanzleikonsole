import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  config: null as unknown,
  cookies: vi.fn(),
  decode: vi.fn(),
  isTokenRevoked: vi.fn(),
  findUnique: vi.fn(),
  nextAuth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({ cookies: m.cookies }));
vi.mock('next-auth/jwt', () => ({ decode: m.decode }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    m.config = config;
    m.nextAuth(config);
    return { handlers: {}, signIn: m.signIn, signOut: m.signOut };
  },
}));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'test-auth-secret',
    NEXTAUTH_TRUST_HOST: true,
  },
}));
vi.mock('../magic-link', () => ({ verifyMagicLink: vi.fn() }));
vi.mock('../revocation', () => ({ isTokenRevoked: m.isTokenRevoked }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: vi.fn(),
  checkIpOrGlobalLimit: vi.fn(),
}));
vi.mock('../session-cookie', () => ({
  PORTAL_SESSION_COOKIE: 'portal-session',
  PORTAL_SESSION_COOKIE_BASE: 'portal-session',
  PORTAL_SESSION_JWT_DECODE_SALTS: ['portal-session'],
  PORTAL_SESSION_JWT_SALT: 'portal-session',
  USE_SECURE_COOKIES: false,
  sessionCookieNameVariants: () => ['portal-session'],
}));
vi.mock('../session-jwt', () => ({ createStableSessionJwtOptions: () => ({}) }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { clientContact: { findUnique: m.findUnique } },
}));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import { portalAuth } from '../portal';

const CONTACT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

function token(email?: string) {
  return {
    sub: CONTACT_ID,
    ...(email === undefined ? {} : { email }),
    name: 'Rey Koxha',
    contactId: CONTACT_ID,
    tenantId: 'tenant-1',
    clientId: CLIENT_ID,
    fullName: 'Rey Koxha',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.cookies.mockResolvedValue({ get: () => ({ value: 'encoded-token' }) });
  m.isTokenRevoked.mockResolvedValue(false);
  m.findUnique.mockResolvedValue({
    active: true,
    email: 'bob@example.test',
    tenantId: 'tenant-1',
    clientId: CLIENT_ID,
    client: { allowActive: true, anonymizedAt: null },
  });
});

describe('Portal-Session bindet die aktuelle Kontakt-E-Mail', () => {
  it('verwirft einen alten Cookie nach einem Kontakt-E-Mail-Wechsel', async () => {
    m.decode.mockResolvedValue(token('alice@example.test'));

    await expect(portalAuth()).resolves.toBeNull();
    expect(m.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONTACT_ID },
        select: expect.objectContaining({ email: true }),
      }),
    );
  });

  it('verwirft Legacy-Tokens ohne E-Mail fail-closed noch vor dem DB-Lookup', async () => {
    m.decode.mockResolvedValue(token());

    await expect(portalAuth()).resolves.toBeNull();
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it('wendet dieselbe E-Mail-Bindung im NextAuth-Session-Callback an', async () => {
    const config = m.config as {
      callbacks: {
        session: (input: {
          session: Record<string, unknown>;
          token: Record<string, unknown>;
        }) => Promise<Record<string, unknown>> | Record<string, unknown>;
      };
    };
    const session = {
      user: { id: CONTACT_ID, email: 'alice@example.test', name: 'Rey Koxha' },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    };

    const hydrated = await config.callbacks.session({
      session,
      token: token('alice@example.test'),
    });

    expect(hydrated).toBe(session);
    expect(session.user).not.toHaveProperty('contactId');
    expect(session.user).not.toHaveProperty('clientId');
  });
});
