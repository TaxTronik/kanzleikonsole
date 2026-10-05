// Fachkatalog: ACCESS-TENANT-RLS-001
// S-09: Staff-Konten dürfen weder über die Meldung noch über die Antwortzeit
// ermittelbar sein. Echte Passwort-Action, lokaler Formularpfad, Rate-Limiter
// und Lockout; ersetzt sind Persistenz, Redis und der bcrypt-Vergleich
// (gezählt, mit dem übergebenen Hash). Seit R-04 prüfen nur noch diese beiden
// Einstiege ein Passwort; Credentials-Provider und Enrollment lösen Tickets ein.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

interface Account {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  active: boolean;
  passwordHash: string;
  authRevision: number;
  totpSecretEnc: string | null;
  totpEnrolledAt: Date | null;
  totpSetupStartedAt: Date | null;
  totpBackupCodes: string[];
  hardwareOnlyEnabledAt: Date | null;
  lockedUntil: Date | null;
  failedLoginCount: number;
  roles: { role: string }[];
  permissions: { permission: string }[];
}

const h = vi.hoisted(() => ({
  account: null as unknown as Account,
  compare: vi.fn(),
  evidence: vi.fn(),
  counters: new Map<string, { count: number; until: number }>(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }),
  cookies: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next-auth/providers/credentials', () => ({ default: (config: unknown) => config }));
vi.mock('next-auth', () => ({
  AuthError: class AuthError extends Error {},
  default: () => ({ handlers: {}, signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock('bcryptjs', () => ({
  compare: h.compare,
  default: { compare: h.compare, hash: vi.fn() },
}));
// Der Passwortvergleich läuft im Worker-Thread-Pool; hier wie zuvor gegen die
// bcryptjs-Attrappe dieses Tests (gezählt), die Fehlerklassen bleiben echt.
vi.mock('../password-hash-pool', async (importOriginal) => {
  const bcrypt = (await import('bcryptjs')).default;
  return {
    ...(await importOriginal<typeof import('../password-hash-pool')>()),
    comparePasswordHash: (password: string, hash: string) => bcrypt.compare(password, hash),
  };
});
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('@taxtronik/config', () => ({
  env: {
    AUTH_SECRET: 'test-only-staff-enumeration-secret',
    NEXTAUTH_URL: 'https://staff.example.test',
    NODE_ENV: 'production',
    TRUST_PROXY_REQUIRED: true,
    TRUST_PROXY_HOPS: 1,
  },
}));
vi.mock('../totp', () => ({
  decryptTotpSecret: () => 'secret',
  verifyTotpCode: () => true,
  generateTotpSecret: vi.fn(),
  buildTotpUri: vi.fn(),
  encryptTotpSecret: vi.fn(),
}));
vi.mock('../totp-replay', () => ({ consumeTotpCode: async () => true }));
vi.mock('../revocation', () => ({ isTokenRevoked: vi.fn() }));
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
    sadd: async () => 1,
    scard: async () => 1,
    expire: async () => 1,
    del: async (key: string) => (h.counters.delete(key) ? 1 : 0),
  }),
}));

function update({ data }: { data: Record<string, unknown> }) {
  const { failedLoginCount, ...rest } = data;
  Object.assign(h.account, rest);
  if (typeof failedLoginCount === 'number') h.account.failedLoginCount = failedLoginCount;
  else if (failedLoginCount) h.account.failedLoginCount += 1;
  return structuredClone(h.account);
}

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    tenant: {
      findFirst: async ({ where }: { where: { slug: string } }) =>
        where.slug === 'default' ? { id: 'tenant-1' } : null,
    },
    staffUser: {
      findFirst: async ({ where }: { where: { tenantId: string; email: string } }) =>
        where.tenantId === h.account.tenantId && where.email === h.account.email
          ? structuredClone(h.account)
          : null,
      update: async (args: { data: Record<string, unknown> }) => update(args),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ staffUser: { update } }),
  },
}));

import { checkPasswordAction } from '@/app/staff/(auth)/login/actions';
import { POST as passwordFormRoute } from '@/app/staff/(auth)/login/password/route';
import { DUMMY_PASSWORD_HASH, STAFF_PASSWORD_HASH_COST } from '../staff-password';
import {
  PasswordHashPoolSaturatedError,
  PasswordHashPoolUnavailableError,
} from '../password-hash-pool';

const NOW = new Date('2026-10-05T09:00:00Z');
const ACCOUNT_HASH = 'hash:richtiges-passwort';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-1',
    email: 'ziel@example.test',
    fullName: 'Ziel',
    active: true,
    passwordHash: ACCOUNT_HASH,
    authRevision: 0,
    totpSecretEnc: 'encrypted-secret',
    totpEnrolledAt: null,
    totpSetupStartedAt: new Date(NOW.getTime() - 60_000),
    totpBackupCodes: [],
    hardwareOnlyEnabledAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    roles: [{ role: 'EMPLOYEE' }],
    permissions: [],
    ...overrides,
  };
}

interface Attempt {
  tenantSlug: string;
  email: string;
  password: string;
  account: Account;
}

// Bewusst mit RICHTIGEM Passwort für die unzulässigen Konten: auch dann
// unterscheidet sich weder Meldung noch Hashaufwand vom falschen Passwort.
const CASES: Record<string, Attempt> = {
  'unbekannte Kanzlei': {
    tenantSlug: 'andere-kanzlei',
    email: 'ziel@example.test',
    password: 'richtiges-passwort',
    account: account(),
  },
  'unbekanntes Konto': {
    tenantSlug: 'default',
    email: 'niemand@example.test',
    password: 'richtiges-passwort',
    account: account(),
  },
  'deaktiviertes Konto': {
    tenantSlug: 'default',
    email: 'ziel@example.test',
    password: 'richtiges-passwort',
    account: account({ active: false }),
  },
  'gesperrtes Konto': {
    tenantSlug: 'default',
    email: 'ziel@example.test',
    password: 'richtiges-passwort',
    account: account({ lockedUntil: new Date(NOW.getTime() + 60_000) }),
  },
  'Hardware-only-Konto': {
    tenantSlug: 'default',
    email: 'ziel@example.test',
    password: 'richtiges-passwort',
    account: account({ hardwareOnlyEnabledAt: NOW }),
  },
  'falsches Passwort': {
    tenantSlug: 'default',
    email: 'ziel@example.test',
    password: 'falsches-passwort',
    account: account(),
  },
};

const ENTRY_POINTS = {
  checkPasswordAction: (a: Attempt) => checkPasswordAction(a.email, a.password, a.tenantSlug),
  'POST /staff/login/password': async (a: Attempt) => {
    const response = await passwordFormRoute(
      new NextRequest('https://staff.example.test/staff/login/password', {
        method: 'POST',
        body: new URLSearchParams({
          email: a.email,
          password: a.password,
          tenantSlug: a.tenantSlug,
        }),
      }),
    );
    return { status: response.status, location: response.headers.get('location') };
  },
};

const EXPECTED_REJECTION = {
  checkPasswordAction: { ok: false, error: 'Ungültige Anmeldedaten.' },
  'POST /staff/login/password': {
    status: 303,
    location: 'https://staff.example.test/staff/login?error=password-invalid',
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.counters.clear();
  h.compare.mockImplementation(async (plain: string, hashed: string) => hashed === `hash:${plain}`);
  h.evidence.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('S-09: Staff-Konten sind weder über Meldung noch Antwortzeit ermittelbar', () => {
  it('vergleicht gegen einen echten bcrypt-Hash mit den Produktionskosten', async () => {
    vi.useRealTimers(); // bcryptjs rechnet asynchron in setImmediate-Schritten
    const bcrypt = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
    expect(STAFF_PASSWORD_HASH_COST).toBe(12);
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(STAFF_PASSWORD_HASH_COST);
    await expect(bcrypt.compare('richtiges-passwort', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  }, 30_000);

  describe.each(Object.keys(ENTRY_POINTS) as Array<keyof typeof ENTRY_POINTS>)('%s', (entry) => {
    it.each(Object.keys(CASES))(
      '%s: generische Ablehnung mit genau einem Hashvergleich',
      async (name) => {
        const attempt = CASES[name]!;
        h.account = attempt.account;

        await expect(ENTRY_POINTS[entry](attempt)).resolves.toEqual(EXPECTED_REJECTION[entry]);

        expect(h.compare).toHaveBeenCalledTimes(1);
        const [plain, hash] = h.compare.mock.calls[0]!;
        expect(plain).toBe(attempt.password);
        // Nur ein zulässiges Konto wird gegen seinen eigenen Hash geprüft.
        expect(hash).toBe(name === 'falsches Passwort' ? ACCOUNT_HASH : DUMMY_PASSWORD_HASH);
      },
    );

    it('liefert für alle Fälle dieselbe Antwort', async () => {
      const results = [];
      for (const attempt of Object.values(CASES)) {
        h.account = attempt.account;
        h.counters.clear(); // IP-Limits sind kontounabhängig und hier nicht Gegenstand
        results.push(JSON.stringify(await ENTRY_POINTS[entry](attempt)));
      }
      expect(new Set(results).size).toBe(1);
      expect(h.compare).toHaveBeenCalledTimes(Object.keys(CASES).length);
    });
  });

  it.each([
    ['ausgelastet', () => new PasswordHashPoolSaturatedError()],
    ['gestört', () => new PasswordHashPoolUnavailableError()],
  ])(
    'Passwortprüfung %s: dieselbe Ablehnung für jedes Konto, kein gezählter Fehlversuch',
    async (_case, error) => {
      const failedBefore = CASES['falsches Passwort']!.account.failedLoginCount;
      for (const entry of Object.keys(ENTRY_POINTS) as Array<keyof typeof ENTRY_POINTS>) {
        for (const attempt of Object.values(CASES)) {
          h.account = attempt.account;
          h.counters.clear();
          h.compare.mockRejectedValueOnce(error());
          await expect(ENTRY_POINTS[entry](attempt)).resolves.toEqual(EXPECTED_REJECTION[entry]);
        }
      }
      // Ungeprüfte Versuche zählen weder für den Lockout noch ins Audit.
      expect(h.evidence).not.toHaveBeenCalled();
      expect(CASES['falsches Passwort']!.account.failedLoginCount).toBe(failedBefore);
      expect(h.compare).toHaveBeenCalledTimes(2 * Object.keys(CASES).length);
    },
  );

  it('protokolliert Fehlversuche weiterhin nur für das existierende zulässige Konto', async () => {
    for (const attempt of Object.values(CASES)) {
      h.account = attempt.account;
      await checkPasswordAction(attempt.email, attempt.password, attempt.tenantSlug);
    }
    expect(h.evidence).toHaveBeenCalledTimes(1);
    expect(h.evidence.mock.calls[0]![1]).toMatchObject({
      action: 'auth.login.failure',
      after: { reason: 'password' },
    });
  });
});
