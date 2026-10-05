// Fachkatalog: ACCESS-TENANT-RLS-001
// R-04: ein Passwort-Authenticator-Service. Schritt 2 löst ein kurzlebiges,
// an staffId, authRevision und Passwort-Hash gebundenes Einmal-Ticket ein,
// statt das Passwort erneut zu prüfen. Echte Passwort-Action, Credentials-
// Provider, Ticket-Store, Rate-Limiter und Lockout gegen zustandsbehaftete
// Redis-/DB-Doubles; bcrypt wird gezählt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Authorize = (
  credentials: Record<string, string>,
  request: Request,
) => Promise<{ authMethod: string } | null>;

const h = vi.hoisted(() => ({
  config: null as unknown as { providers: { authorize: Authorize }[] },
  account: {} as Record<string, unknown>,
  compare: vi.fn(),
  verifyTotp: vi.fn(),
  evidence: vi.fn(),
  counters: new Map<string, { count: number; until: number }>(),
  tickets: new Map<string, { value: string; until: number }>(),
  ticketTtls: [] as number[],
  redisDown: false,
  env: {
    AUTH_SECRET: 'test-only-login-ticket-secret-with-32-chars',
    NEXTAUTH_URL: 'https://staff.example.test',
    NODE_ENV: 'production',
    TRUST_PROXY_REQUIRED: true,
    TRUST_PROXY_HOPS: 1,
  } as Record<string, unknown>,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.20' }),
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
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,qr' } }));
vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('../totp', () => ({
  decryptTotpSecret: () => 'secret',
  verifyTotpCode: h.verifyTotp,
  generateTotpSecret: vi.fn(),
  buildTotpUri: () => 'otpauth://fixture',
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
    set: async (key: string, value: string, ex: string, ttl: number, nx: string) => {
      if (h.redisDown) throw new Error('Redis unavailable');
      expect([ex, nx]).toEqual(['EX', 'NX']);
      if (h.tickets.has(key)) return null;
      h.ticketTtls.push(ttl);
      h.tickets.set(key, { value, until: Date.now() + ttl * 1000 });
      return 'OK';
    },
    getdel: async (key: string) => {
      if (h.redisDown) throw new Error('Redis unavailable');
      const entry = h.tickets.get(key);
      h.tickets.delete(key);
      return entry && entry.until > Date.now() ? entry.value : null;
    },
  }),
}));

function matches(where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR' || value === undefined) return true;
    if (value && typeof value === 'object' && !(value instanceof Date)) return true;
    const current = h.account[key];
    if (value instanceof Date) return (current as Date | null)?.getTime() === value.getTime();
    return current === value;
  });
}

function update({ data }: { data: Record<string, unknown> }) {
  const { failedLoginCount, ...rest } = data;
  Object.assign(h.account, rest);
  if (typeof failedLoginCount === 'number') h.account['failedLoginCount'] = failedLoginCount;
  return { count: 1 };
}

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    tenant: { findFirst: async () => ({ id: 'tenant-1' }) },
    staffUser: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? structuredClone(h.account) : null,
      update: async (args: { data: Record<string, unknown> }) => update(args),
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => (matches(args.where) ? update(args) : { count: 0 }),
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        staffUser: { update, updateMany: update },
        $queryRaw: async () => [{ totp_backup_codes: h.account['totpBackupCodes'] }],
      }),
  },
}));

import { checkPasswordAction } from '@/app/staff/(auth)/login/actions';
import { STAFF_LOGIN_TICKET_TTL_SECONDS } from '../staff-login-ticket';

const NOW = new Date('2026-10-05T11:00:00Z');
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

function enrolledAccount(): Record<string, unknown> {
  return {
    id: STAFF_ID,
    tenantId: 'tenant-1',
    email: 'staff@example.test',
    fullName: 'Staff Test',
    active: true,
    passwordHash: 'hash:password',
    authRevision: 3,
    totpSecretEnc: 'encrypted-secret',
    totpEnrolledAt: new Date('2026-09-01'),
    totpSetupStartedAt: null,
    totpBackupCodes: [],
    hardwareOnlyEnabledAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    roles: [{ role: 'EMPLOYEE' }],
    permissions: [{ permission: 'INVOICE_SEND' }],
  };
}

function authorize(loginTicket: string, totpCode: string) {
  return h.config.providers[0]!.authorize(
    { loginTicket, totpCode },
    new Request('https://staff.example.test/api/auth/staff/callback/credentials', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.20' },
    }),
  );
}

async function passwordStep(password = 'password') {
  const result = await checkPasswordAction('staff@example.test', password);
  expect(result).toMatchObject({ ok: true });
  return result.loginTicket!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.account = enrolledAccount();
  h.counters.clear();
  h.tickets.clear();
  h.ticketTtls = [];
  h.redisDown = false;
  h.compare.mockImplementation(async (plain: string, hashed: string) => hashed === `hash:${plain}`);
  h.verifyTotp.mockImplementation((code: string) => code === '123456');
  h.evidence.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  h.env['NODE_ENV'] = 'production';
});

describe('R-04: ein Passwort-bcrypt je Anmeldung, Schritt 2 über ein Einmal-Ticket', () => {
  it('meldet mit Passwort und TOTP an und vergleicht das Passwort genau einmal', async () => {
    const ticket = await passwordStep();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(authorize(ticket, '123456')).resolves.toMatchObject({
      authMethod: 'totp',
      authRevision: 3,
      staffId: STAFF_ID,
      permissions: ['INVOICE_SEND'],
    });
    expect(h.compare).toHaveBeenCalledExactlyOnceWith('password', 'hash:password');
    expect(h.ticketTtls).toEqual([STAFF_LOGIN_TICKET_TTL_SECONDS]);
    expect(STAFF_LOGIN_TICKET_TTL_SECONDS).toBe(300);
  });

  it('lässt jedes Ticket nur einmal zu — auch nach falschem Code', async () => {
    const used = await passwordStep();
    await expect(authorize(used, '123456')).resolves.toMatchObject({ authMethod: 'totp' });
    await expect(authorize(used, '123456')).resolves.toBeNull();

    const guessed = await passwordStep();
    await expect(authorize(guessed, '000000')).resolves.toBeNull();
    await expect(authorize(guessed, '123456')).resolves.toBeNull();
    expect(h.verifyTotp).toHaveBeenCalledTimes(2);
  });

  it('verbraucht das Ticket nicht ohne Code', async () => {
    const ticket = await passwordStep();
    await expect(authorize(ticket, '')).resolves.toBeNull();
    await expect(authorize(ticket, '123456')).resolves.toMatchObject({ authMethod: 'totp' });
  });

  it.each([
    ['geänderter authRevision', () => (h.account['authRevision'] = 4)],
    ['geändertem Passwort', () => (h.account['passwordHash'] = 'hash:neu')],
    ['Deaktivierung', () => (h.account['active'] = false)],
    ['Kontosperre', () => (h.account['lockedUntil'] = new Date(NOW.getTime() + 60_000))],
    ['Hardware-only', () => (h.account['hardwareOnlyEnabledAt'] = NOW)],
  ])('weist das Ticket nach %s zwischen den Schritten ab', async (_name, change) => {
    const ticket = await passwordStep();
    change();
    await expect(authorize(ticket, '123456')).resolves.toBeNull();
    expect(h.verifyTotp).not.toHaveBeenCalled();
    expect(h.compare).toHaveBeenCalledTimes(1);
  });

  it('verwirft Tickets nach fünf Minuten', async () => {
    const ticket = await passwordStep();
    vi.setSystemTime(new Date(NOW.getTime() + 301_000));
    await expect(authorize(ticket, '123456')).resolves.toBeNull();
    expect(h.verifyTotp).not.toHaveBeenCalled();
  });

  it('akzeptiert kein Erst-Setup-Ticket für den Login und keine erfundenen Tickets', async () => {
    h.account['totpEnrolledAt'] = null;
    h.account['totpSetupStartedAt'] = new Date(NOW.getTime() - 60_000);
    const setup = await checkPasswordAction('staff@example.test', 'password');
    expect(setup).toMatchObject({ ok: true, totpSetupRequired: true });
    h.account['totpEnrolledAt'] = new Date('2026-09-01');
    await expect(authorize(setup.loginTicket!, '123456')).resolves.toBeNull();
    await expect(authorize('A'.repeat(43), '123456')).resolves.toBeNull();
    await expect(authorize('kein-ticket', '123456')).resolves.toBeNull();
    expect(h.verifyTotp).not.toHaveBeenCalled();
  });

  it('legt in Redis weder Ticket noch Passwort-Hash im Klartext ab', async () => {
    const ticket = await passwordStep();
    expect(h.tickets.size).toBe(1);
    const [key, entry] = [...h.tickets][0]!;
    expect(key).not.toContain(ticket);
    expect(entry.value).not.toContain('hash:password');
    expect(JSON.parse(entry.value)).toMatchObject({
      purpose: 'second-factor',
      staffId: STAFF_ID,
      tenantId: 'tenant-1',
      authRevision: 3,
    });
  });

  it('meldet ohne Ticket-Speicher niemanden an (fail-closed)', async () => {
    h.redisDown = true;
    await expect(checkPasswordAction('staff@example.test', 'password')).resolves.toEqual({
      ok: false,
      error: 'Anmeldung derzeit nicht möglich. Bitte später erneut versuchen.',
    });
  });

  it('vergleicht einen falschen sechsstelligen Code nicht mit den Backup-Codes', async () => {
    h.account['totpBackupCodes'] = Array.from({ length: 8 }, (_, i) => `hash:BACKUPCOD${i}`);
    await expect(authorize(await passwordStep(), '000000')).resolves.toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(1);

    h.compare.mockClear();
    await expect(authorize(await passwordStep(), 'BACKUPCOD5')).resolves.toMatchObject({
      authMethod: 'backup_code',
    });
    // Passwortschritt + Backup-Codes bis zum Treffer.
    expect(h.compare).toHaveBeenCalledTimes(1 + 6);
  });
});

describe('R-04: lokaler DEV-Formularpfad nutzt denselben Service', () => {
  it('meldet mit genau einem bcrypt an und stellt das Cookie aus der Session-Fabrik aus', async () => {
    // DEV_SKIP_TOTP wirkt nur außerhalb von Production (Modulkonstante).
    h.env['NODE_ENV'] = 'development';
    vi.stubEnv('DEV_SKIP_TOTP', 'true');
    vi.resetModules();
    const { POST } = await import('@/app/staff/(auth)/login/password/route');
    const { STAFF_SESSION_COOKIE } = await import('../session-cookie');
    h.account['totpEnrolledAt'] = null;
    h.account['totpSecretEnc'] = null;

    const response = await POST(
      new NextRequest(
        'https://staff.example.test/staff/login/password?returnTo=%2Fstaff%2Fdashboard',
        {
          method: 'POST',
          body: new URLSearchParams({ email: 'staff@example.test', password: 'password' }),
        },
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://staff.example.test/staff/dashboard');
    expect(response.cookies.get(STAFF_SESSION_COOKIE)?.value).toBeTruthy();
    expect(h.compare).toHaveBeenCalledTimes(1);
    expect(h.tickets.size).toBe(0);
    expect(h.evidence.mock.calls.map((call) => (call[1] as { after: unknown }).after)).toEqual([
      { email: 'staff@example.test', method: 'dev_skip_totp' },
    ]);
  });
});
