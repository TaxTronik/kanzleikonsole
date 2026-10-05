// Fachkatalog: ACCESS-TENANT-RLS-001
// Exercise the real password action, credentials provider, rate limiter and
// lockout service. Only external persistence/crypto boundaries are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Authorize = (
  credentials: Record<string, string>,
  request: Request,
) => Promise<{ authMethod: string } | null>;

const h = vi.hoisted(() => ({
  config: null as unknown as { providers: { authorize: Authorize }[] },
  headers: new Headers(),
  findFirst: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  compare: vi.fn(),
  verifyTotp: vi.fn(),
  consumeTotp: vi.fn(),
  evidence: vi.fn(),
  eval: vi.fn(),
  sadd: vi.fn(),
  scard: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => h.headers, cookies: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('next-auth', () => ({
  AuthError: class AuthError extends Error {},
  default: (config: typeof h.config) => {
    h.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock('bcryptjs', () => ({
  compare: h.compare,
  default: { compare: h.compare, hash: vi.fn() },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'test-only-second-factor-secret',
    NEXTAUTH_URL: 'https://staff.example.test',
    NODE_ENV: 'production',
    TRUST_PROXY_REQUIRED: true,
  },
}));
vi.mock('../totp', () => ({
  decryptTotpSecret: () => 'secret',
  verifyTotpCode: h.verifyTotp,
  generateTotpSecret: vi.fn(),
  buildTotpUri: vi.fn(),
  encryptTotpSecret: vi.fn(),
}));
vi.mock('../totp-replay', () => ({ consumeTotpCode: h.consumeTotp }));
vi.mock('../revocation', () => ({ isTokenRevoked: vi.fn() }));
vi.mock('../session-jwt', () => ({ createStableSessionJwtOptions: () => ({}) }));
vi.mock('../webauthn', () => ({
  authenticateStaffHardwareCredential: vi.fn(),
  beginHardwareLogin: vi.fn(),
  isAuthenticationResponse: vi.fn(),
  isHardwareAccessConfigured: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidence } }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    eval: h.eval,
    sadd: h.sadd,
    scard: h.scard,
    expire: h.expire,
    del: h.del,
  }),
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    tenant: { findFirst: async () => ({ id: 'tenant-1' }) },
    staffUser: { findFirst: h.findFirst, update: h.update },
    $transaction: h.transaction,
  },
}));

import { checkPasswordAction } from '@/app/staff/(auth)/login/actions';
import { staffSecondFactorAccountRateLimitKey } from '@/server/rate-limit';
import { DUMMY_PASSWORD_HASH } from '../staff-password';

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_FACTOR_KEY = `rl:${staffSecondFactorAccountRateLimitKey(STAFF_ID)}`;
const NOW = new Date('2026-10-01T10:00:00Z');

function initialAccount() {
  return {
    id: STAFF_ID,
    tenantId: 'tenant-1',
    email: 'staff@example.test',
    fullName: 'Staff Test',
    active: true,
    passwordHash: 'hash:password',
    authRevision: 0,
    totpSecretEnc: 'encrypted-secret',
    totpEnrolledAt: new Date('2026-09-01'),
    totpSetupStartedAt: null,
    totpBackupCodes: ['hash:RECOVERY23'],
    hardwareOnlyEnabledAt: null as Date | null,
    lockedUntil: null as Date | null,
    failedLoginCount: 0,
    roles: [{ role: 'EMPLOYEE' }],
    permissions: [],
  };
}

let account = initialAccount();
const counters = new Map<string, { count: number; until: number }>();
const distinctIps = new Map<string, Set<string>>();

function request(ip = '203.0.113.1') {
  h.headers = new Headers({ 'x-forwarded-for': ip });
  return new Request('https://staff.example.test/api/auth/staff/callback/credentials', {
    method: 'POST',
    headers: h.headers,
  });
}

function login(code: string, ip = '203.0.113.1', password = 'password') {
  return h.config.providers[0]!.authorize(
    { email: account.email, password, totpCode: code, tenantSlug: 'default' },
    request(ip),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  account = initialAccount();
  counters.clear();
  distinctIps.clear();
  h.findFirst.mockImplementation(async () => structuredClone(account));
  h.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const { failedLoginCount, ...rest } = data;
    Object.assign(account, rest);
    if (typeof failedLoginCount === 'number') account.failedLoginCount = failedLoginCount;
    else if (failedLoginCount) account.failedLoginCount += 1;
    return structuredClone(account);
  });
  h.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ staffUser: { update: h.update }, $queryRaw: h.queryRaw }),
  );
  h.queryRaw.mockImplementation(async () => [{ totp_backup_codes: [...account.totpBackupCodes] }]);
  h.compare.mockImplementation(async (plain: string, hashed: string) => hashed === `hash:${plain}`);
  h.verifyTotp.mockImplementation((code: string) => code === '123456');
  h.consumeTotp.mockResolvedValue(true);
  h.evidence.mockResolvedValue(undefined);
  h.eval.mockImplementation(async (_script, _keyCount, key: string, window: string) => {
    let entry = counters.get(key);
    if (!entry || entry.until <= Date.now()) {
      entry = { count: 0, until: Date.now() + Number(window) * 1000 };
      counters.set(key, entry);
    }
    entry.count++;
    return [entry.count, Math.ceil((entry.until - Date.now()) / 1000)];
  });
  h.sadd.mockImplementation(async (key: string, ip: string) => {
    const values = distinctIps.get(key) ?? new Set<string>();
    values.add(ip);
    distinctIps.set(key, values);
    return 1;
  });
  h.scard.mockImplementation(async (key: string) => distinctIps.get(key)?.size ?? 0);
  h.expire.mockResolvedValue(1);
  h.del.mockImplementation(async (key: string) => {
    counters.delete(key);
    distinctIps.delete(key);
    return 1;
  });
});

afterEach(() => vi.useRealTimers());

describe('ACCESS-TENANT-RLS-001: account second-factor attempts survive password-only checks', () => {
  it('blocks distributed guesses despite repeated successful password prechecks', async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ip = `203.0.113.${attempt + 1}`;
      request(ip);
      await expect(checkPasswordAction(account.email, 'password')).resolves.toMatchObject({
        ok: true,
        totpRequired: true,
      });
      await expect(login('000000', ip)).resolves.toBeNull();
    }
    // Password checks really did clear the old distributed-lockout state.
    expect(account.lockedUntil).toBeNull();
    expect(h.verifyTotp).toHaveBeenCalledTimes(5);
    expect(counters.get(SECOND_FACTOR_KEY)?.count).toBe(12);
    expect(h.del).not.toHaveBeenCalledWith(SECOND_FACTOR_KEY);
    // Even a correct TOTP cannot bypass a exhausted quota; expiry restores it.
    await expect(login('123456', '203.0.113.99')).resolves.toBeNull();
    vi.setSystemTime(new Date(NOW.getTime() + 301_000));
    await expect(login('123456', '203.0.113.99')).resolves.toMatchObject({ authMethod: 'totp' });
    expect(counters.has(SECOND_FACTOR_KEY)).toBe(false);
  });

  it('shares the quota with recovery codes and resets it after their one-time consumption', async () => {
    await expect(login('000000')).resolves.toBeNull();
    await expect(login('RECOVERY23')).resolves.toMatchObject({ authMethod: 'backup_code' });
    expect(account.totpBackupCodes).toEqual([]);
    expect(counters.has(SECOND_FACTOR_KEY)).toBe(false);
    await expect(login('RECOVERY23')).resolves.toBeNull();
    expect(counters.get(SECOND_FACTOR_KEY)?.count).toBe(1);
  });

  it('does not let rejected passwords or missing codes consume the second-factor quota', async () => {
    await expect(login('000000', '203.0.113.1', 'wrong-password')).resolves.toBeNull();
    await expect(login('')).resolves.toBeNull();
    expect(counters.has(SECOND_FACTOR_KEY)).toBe(false);
    expect(h.verifyTotp).not.toHaveBeenCalled();
  });

  it('keeps attempts after rejected TOTP replays or a failed login audit', async () => {
    h.consumeTotp.mockResolvedValueOnce(false);
    await expect(login('123456')).resolves.toBeNull();
    expect(counters.get(SECOND_FACTOR_KEY)?.count).toBe(1);
    h.evidence.mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(login('123456')).rejects.toThrow('Audit unavailable');
    expect(counters.get(SECOND_FACTOR_KEY)?.count).toBe(2);
  });

  it('fails closed when the second-factor Redis bucket cannot be updated', async () => {
    const evaluate = h.eval.getMockImplementation()!;
    h.eval.mockImplementation((...args) => {
      if (args[2] === SECOND_FACTOR_KEY) throw new Error('Redis unavailable');
      return evaluate(...args);
    });
    await expect(login('123456')).resolves.toBeNull();
    expect(h.verifyTotp).not.toHaveBeenCalled();
  });

  it('preserves hardware-only rejection of both TOTP and recovery-code password flows', async () => {
    account.hardwareOnlyEnabledAt = NOW;
    await expect(login('123456')).resolves.toBeNull();
    await expect(login('RECOVERY23')).resolves.toBeNull();
    // S-09: je Versuch genau ein Vergleich, aber nie gegen den Kontohash.
    expect(h.compare.mock.calls.map(([, hash]) => hash)).toEqual([
      DUMMY_PASSWORD_HASH,
      DUMMY_PASSWORD_HASH,
    ]);
    expect(counters.has(SECOND_FACTOR_KEY)).toBe(false);
  });
});
