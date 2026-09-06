// Fachkatalog: ACCESS-TENANT-RLS-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: null as unknown,
  cookies: vi.fn(),
  decode: vi.fn(),
  isTokenRevoked: vi.fn(),
  staffFindUnique: vi.fn(),
}));

vi.mock('react', () => ({ cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next-auth/jwt', () => ({ decode: mocks.decode }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('next-auth', () => ({
  default: (config: unknown) => {
    mocks.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock('bcryptjs', () => ({ compare: vi.fn() }));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'test-auth-secret',
    NEXTAUTH_TRUST_HOST: true,
    NEXTAUTH_URL: 'https://kanzlei.example.test',
    NODE_ENV: 'test',
    STAFF_COOKIE_DOMAIN: undefined,
  },
}));
vi.mock('../totp', () => ({ decryptTotpSecret: vi.fn(), verifyTotpCode: vi.fn() }));
vi.mock('../lockout', () => ({ resetFailedLogin: vi.fn() }));
vi.mock('../login-audit', () => ({ recordFailedLoginAudited: vi.fn(), auditIp: vi.fn() }));
vi.mock('../revocation', () => ({ isTokenRevoked: mocks.isTokenRevoked }));
vi.mock('../session-cookie', () => ({
  STAFF_SESSION_COOKIE: 'staff-session',
  STAFF_SESSION_COOKIE_BASE: 'staff-session',
  STAFF_SESSION_JWT_DECODE_SALTS: ['staff-session'],
  STAFF_SESSION_JWT_SALT: 'staff-session',
  USE_SECURE_COOKIES: false,
  sessionCookieNameVariants: () => ['staff-session'],
  readSessionCookieValue: (
    jar: { get(name: string): { value: string } | undefined },
    names: string[],
  ) => names.map((name) => jar.get(name)?.value).find(Boolean) ?? null,
}));
vi.mock('../session-jwt', () => ({ createStableSessionJwtOptions: () => ({}) }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('../totp-replay', () => ({ consumeTotpCode: vi.fn() }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: { staffUser: { findUnique: mocks.staffFindUnique } },
}));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: vi.fn(),
  checkIpOrGlobalLimit: vi.fn(),
  checkStaffPasswordAccountLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  staffPasswordAccountRateLimitKey: vi.fn(),
}));
vi.mock('../webauthn', () => ({ authenticateStaffHardwareCredential: vi.fn() }));

import { staffAuth } from '../staff';

const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function token(authRevision?: number) {
  return {
    sub: STAFF_ID,
    email: 'staff@example.test',
    name: 'Staff Test',
    staffId: STAFF_ID,
    tenantId: TENANT_ID,
    fullName: 'Staff Test',
    roles: ['EMPLOYEE'],
    permissions: [],
    authMethod: 'totp',
    ...(authRevision === undefined ? {} : { authRevision }),
    iat: Math.floor(Date.now() / 1000) - 60,
    sessionIssuedAt: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

function account(authRevision: number) {
  return {
    active: true,
    tenantId: TENANT_ID,
    authRevision,
    hardwareOnlyEnabledAt: null,
    roles: [{ role: 'EMPLOYEE' }],
    permissions: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => ({ value: 'encoded-token' }) });
  mocks.isTokenRevoked.mockResolvedValue(false);
});

describe('Staff-Session bindet Self-Service an die authentisierte Revision', () => {
  it('übernimmt authRevision und authMethod aus dem signierten Token', async () => {
    mocks.decode.mockResolvedValue(token(4));
    mocks.staffFindUnique.mockResolvedValue(account(4));

    await expect(staffAuth()).resolves.toMatchObject({
      user: { staffId: STAFF_ID, authMethod: 'totp', authRevision: 4 },
    });
  });

  it('adoptiert keine parallel erhöhte Datenbankrevision', async () => {
    mocks.decode.mockResolvedValue(token(4));
    mocks.staffFindUnique.mockResolvedValue(account(5));

    await expect(staffAuth()).resolves.toBeNull();
  });

  it('belässt ein zulässiges Legacy-Token ohne Revision bei undefined', async () => {
    mocks.decode.mockResolvedValue(token());
    mocks.staffFindUnique.mockResolvedValue(account(0));

    await expect(staffAuth()).resolves.toMatchObject({
      user: { staffId: STAFF_ID, authRevision: undefined },
    });
  });
});
