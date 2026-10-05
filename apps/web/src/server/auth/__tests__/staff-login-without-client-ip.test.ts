// Fachkatalog: ACCESS-TENANT-RLS-001
// S-03: Staff-Login in Produktion ohne TRUST_PROXY_REQUIRED (keine Client-IP).
// Früher fielen alle Limits auf kleine globale Zähler und die Kontosperre auf
// reines Zählen: fünf anonyme Fehlversuche sperrten jedes bekannte Konto 30 min,
// 200 Anfragen je 10 min blockierten alle Logins. Echte Passwort-Action,
// Credentials-Provider, Rate-Limiter, Lockout und Einmal-Ticket (R-04); nur
// Persistenz, Krypto-Grenzen und Auth.js-Hülle sind ersetzt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Authorize = (
  credentials: Record<string, string>,
  request: Request,
) => Promise<{ authMethod: string } | null>;

interface Account {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  active: boolean;
  passwordHash: string;
  authRevision: number;
  totpSecretEnc: string;
  totpEnrolledAt: Date;
  totpSetupStartedAt: null;
  totpBackupCodes: string[];
  hardwareOnlyEnabledAt: Date | null;
  lockedUntil: Date | null;
  failedLoginCount: number;
  lastLoginAt?: Date;
  roles: { role: string }[];
  permissions: { permission: string }[];
}

const h = vi.hoisted(() => ({
  config: null as unknown as { providers: { authorize: Authorize }[] },
  accounts: new Map<string, Account>(),
  counters: new Map<string, { count: number; until: number }>(),
  tickets: new Map<string, { value: string; until: number }>(),
  compare: vi.fn(),
  verifyTotp: vi.fn(),
  evidence: vi.fn(),
  del: vi.fn(),
  sadd: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.200' }),
  cookies: vi.fn(),
}));
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
    AUTH_SECRET: 'test-only-staff-login-without-ip-secret',
    NEXTAUTH_URL: 'https://staff.example.test',
    NODE_ENV: 'production',
    // Produktions-Default des eigenen Reverse-Proxys: keine Client-IP.
    TRUST_PROXY_REQUIRED: false,
    TRUST_PROXY_HOPS: 1,
  },
}));
vi.mock('../totp', () => ({
  decryptTotpSecret: () => 'secret',
  verifyTotpCode: h.verifyTotp,
  generateTotpSecret: vi.fn(),
  buildTotpUri: vi.fn(),
  encryptTotpSecret: vi.fn(),
}));
vi.mock('../totp-replay', () => ({ consumeTotpCode: async () => true }));
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
    eval: async (_script: string, _keys: number, key: string, window: string) => {
      let entry = h.counters.get(key);
      if (!entry || entry.until <= Date.now()) {
        entry = { count: 0, until: Date.now() + Number(window) * 1000 };
        h.counters.set(key, entry);
      }
      entry.count++;
      return [entry.count, Math.ceil((entry.until - Date.now()) / 1000)];
    },
    sadd: h.sadd,
    scard: async () => 0,
    expire: async () => 1,
    del: h.del,
    set: async (key: string, value: string, _ex: 'EX', ttl: number) => {
      h.tickets.set(key, { value, until: Date.now() + ttl * 1000 });
      return 'OK';
    },
    getdel: async (key: string) => {
      const entry = h.tickets.get(key);
      h.tickets.delete(key);
      return entry && entry.until > Date.now() ? entry.value : null;
    },
  }),
}));

function findAccount(where: Record<string, unknown>): Account | undefined {
  if (typeof where['id'] === 'string') return h.accounts.get(where['id']);
  return [...h.accounts.values()].find((account) => account.email === where['email']);
}

function updateAccount({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
  const account = h.accounts.get(where.id)!;
  const { failedLoginCount, ...rest } = data;
  Object.assign(account, rest);
  if (typeof failedLoginCount === 'number') account.failedLoginCount = failedLoginCount;
  else if (failedLoginCount) account.failedLoginCount += 1;
  return structuredClone(account);
}

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    tenant: { findFirst: async () => ({ id: 'tenant-1' }) },
    staffUser: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const account = findAccount(where);
        return account ? structuredClone(account) : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) =>
        updateAccount(args),
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ staffUser: { update: updateAccount } }),
  },
}));

import { checkPasswordAction } from '@/app/staff/(auth)/login/actions';
import { STORM_CEILING_PER_SECOND, staffPasswordAccountRateLimitKey } from '@/server/rate-limit';

const NOW = new Date('2026-10-05T08:00:00Z');
const TARGET = '11111111-1111-4111-8111-111111111111';
const COLLEAGUE = '22222222-2222-4222-8222-222222222222';

function account(id: string, email: string): Account {
  return {
    id,
    tenantId: 'tenant-1',
    email,
    fullName: email,
    active: true,
    passwordHash: 'hash:password',
    authRevision: 0,
    totpSecretEnc: 'encrypted-secret',
    totpEnrolledAt: new Date('2026-09-01'),
    totpSetupStartedAt: null,
    totpBackupCodes: [],
    hardwareOnlyEnabledAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    roles: [{ role: 'EMPLOYEE' }],
    permissions: [],
  };
}

function target(): Account {
  return h.accounts.get(TARGET)!;
}

function authorize(credentials: Record<string, string>) {
  return h.config.providers[0]!.authorize(
    credentials,
    new Request('https://staff.example.test/api/auth/staff/callback/credentials', {
      method: 'POST',
      // Ohne TRUST_PROXY_REQUIRED muss die App diesen Header ignorieren.
      headers: { 'x-forwarded-for': '198.51.100.23' },
    }),
  );
}

// R-04: Passwortschritt liefert das Einmal-Ticket, Schritt 2 löst es ein.
async function login(email: string, password: string, totpCode = '123456') {
  const step = await checkPasswordAction(email, password);
  if (!step.ok || !step.loginTicket) return null;
  return authorize({ loginTicket: step.loginTicket, totpCode });
}

function auditActions(): string[] {
  return h.evidence.mock.calls.map((call) => (call[1] as { action: string }).action);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.counters.clear();
  h.tickets.clear();
  h.accounts.clear();
  h.accounts.set(TARGET, account(TARGET, 'ziel@example.test'));
  h.accounts.set(COLLEAGUE, account(COLLEAGUE, 'kollegin@example.test'));
  h.compare.mockImplementation(async (plain: string, hashed: string) => hashed === `hash:${plain}`);
  h.verifyTotp.mockImplementation((code: string) => code === '123456');
  h.evidence.mockResolvedValue(undefined);
  h.del.mockImplementation(async (key: string) => {
    h.counters.delete(key);
    return 1;
  });
  h.sadd.mockResolvedValue(1);
});

afterEach(() => vi.useRealTimers());

describe('S-03: Staff-Login ohne vertrauenswürdige Client-IP', () => {
  it('lässt fünf anonyme Fehlversuche das Konto nicht mehr sperren', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(checkPasswordAction('ziel@example.test', 'falsch')).resolves.toMatchObject({
        ok: false,
      });
    }
    expect(target().lockedUntil).toBeNull();
    expect(target().failedLoginCount).toBe(5);
    expect(auditActions()).toEqual(Array(5).fill('auth.login.failure'));
    expect(h.sadd).not.toHaveBeenCalled();

    // Der Inhaber meldet sich danach regulär an — vorher: 30 min gesperrt.
    await expect(checkPasswordAction('ziel@example.test', 'password')).resolves.toMatchObject({
      ok: true,
      totpRequired: true,
    });
    await expect(login('ziel@example.test', 'password')).resolves.toMatchObject({
      authMethod: 'totp',
    });
    expect(auditActions()).not.toContain('auth.login.lockout');
  });

  it('deckelt Passwortversuche pro Konto vor bcrypt, ohne andere Konten zu treffen', async () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      await checkPasswordAction('ziel@example.test', `raten-${attempt}`);
    }
    // 20 Versuche je 10 min erreichen bcrypt, danach wird ohne Prüfung abgewiesen.
    expect(h.compare).toHaveBeenCalledTimes(20);
    expect(h.counters.get(`rl:${staffPasswordAccountRateLimitKey(TARGET)}`)?.count).toBe(25);
    expect(target().lockedUntil).toBeNull();
    expect(auditActions()).not.toContain('auth.login.lockout');

    await expect(checkPasswordAction('kollegin@example.test', 'password')).resolves.toMatchObject({
      ok: true,
    });
    await expect(login('kollegin@example.test', 'password')).resolves.toMatchObject({
      authMethod: 'totp',
    });

    // Bewusster Trade-off: solange das Kontingent erschöpft ist, scheitert auch
    // das richtige Passwort; nach Ablauf des Fensters ist es wieder frei.
    await expect(checkPasswordAction('ziel@example.test', 'password')).resolves.toMatchObject({
      ok: false,
    });
    vi.setSystemTime(new Date(NOW.getTime() + 601_000));
    await expect(checkPasswordAction('ziel@example.test', 'password')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('blockiert nach mehr als 200 fremden Anfragen nicht mehr alle Staff-Logins', async () => {
    for (let attempt = 0; attempt < 250; attempt++) {
      await checkPasswordAction(`unbekannt-${attempt}@example.test`, 'egal');
      // Fremde erreichen den Credentials-Callback auch ohne gültiges Ticket.
      await authorize({ loginTicket: 'x'.repeat(43), totpCode: '000000' });
    }
    expect(h.counters.get('rl:staff-pw:global')?.count).toBe(250);
    expect(h.counters.get('rl:staff-authorize:global')?.count).toBe(250);
    await expect(checkPasswordAction('ziel@example.test', 'password')).resolves.toMatchObject({
      ok: true,
    });
    await expect(login('ziel@example.test', 'password')).resolves.toMatchObject({
      authMethod: 'totp',
    });
    // Ein erfolgreicher Login leert die gemeinsame Obergrenze nicht.
    expect(h.del).not.toHaveBeenCalledWith('rl:staff-pw:global');
    expect(h.del).not.toHaveBeenCalledWith('rl:staff-authorize:global');
    expect(STORM_CEILING_PER_SECOND * 600).toBeGreaterThan(250);
  });

  it('deckelt TOTP-/Backup-Code-Versuche pro Konto, ohne das Konto zu sperren', async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await expect(login('ziel@example.test', 'password', '000000')).resolves.toBeNull();
    }
    expect(h.verifyTotp).toHaveBeenCalledTimes(5);
    expect(target().lockedUntil).toBeNull();
    expect(auditActions()).toEqual(Array(5).fill('auth.login.failure'));
  });
});
