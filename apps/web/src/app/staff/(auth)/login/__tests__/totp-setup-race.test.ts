// Fachkatalog: ACCESS-TENANT-RLS-001.
// Exercise the actual public setup actions against a stateful DB boundary.
// Interleave completed recovery/enrollment with awaited password/code hashing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  onCompare: () => {},
  onHash: () => {},
  onGenerate: () => {},
  onQr: () => {},
  generated: 0,
  audit: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: async (password: string, encoded: string) => {
      h.onCompare();
      return password === 'current-password' && encoded === 'current-hash';
    },
    hash: async (value: string) => {
      h.onHash();
      return `hash:${value}`;
    },
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next-auth', () => ({ AuthError: class AuthError extends Error {} }));
vi.mock('qrcode', () => ({
  default: {
    toDataURL: async () => {
      h.onQr();
      return 'data:image/png;base64,fixture';
    },
  },
}));
vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'fixture-secret' } }));
vi.mock('@/server/auth/totp', () => ({
  generateTotpSecret: () => {
    h.onGenerate();
    return `new-secret-${++h.generated}`;
  },
  encryptTotpSecret: (value: string) => `encrypted:${value}`,
  decryptTotpSecret: (value: string) => value.replace(/^encrypted:/, ''),
  buildTotpUri: (email: string, secret: string) => `${email}:${secret}`,
  verifyTotpCode: (value: string) => value === '123456',
}));
vi.mock('@/server/auth/staff', () => ({ staffSignIn: vi.fn(), DEV_SKIP_TOTP: false }));
vi.mock('@/server/auth/lockout', () => ({ resetFailedLogin: async () => {} }));
vi.mock('@/server/auth/login-audit', () => ({ recordFailedLoginAudited: async () => {} }));
vi.mock('@/server/auth/webauthn', () => ({
  beginHardwareLogin: vi.fn(),
  isAuthenticationResponse: vi.fn(),
  isHardwareAccessConfigured: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => null,
  checkIpOrGlobalLimit: async () => ({ ok: true }),
  checkRateLimit: async () => ({ ok: true }),
  checkStaffPasswordAccountLimit: async () => ({ ok: true }),
  resetRateLimit: async () => {},
  staffPasswordAccountRateLimitKey: (id: string) => id,
}));
vi.mock('@/server/db/prisma-owner', () => {
  const matches = (where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === 'OR') return (value as Array<Record<string, unknown>>).some(matches);
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const range = value as { gte?: Date; lte?: Date };
        const current = h.state[key];
        return (
          current instanceof Date &&
          (!range.gte || current >= range.gte) &&
          (!range.lte || current <= range.lte)
        );
      }
      if (value instanceof Date) return (h.state[key] as Date)?.getTime() === value.getTime();
      return h.state[key] === value;
    });
  const update = ({
    where,
    data,
  }: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => {
    if (!matches(where)) return { count: 0 };
    for (const [key, value] of Object.entries(data)) {
      h.state[key] =
        value && typeof value === 'object' && 'increment' in value
          ? Number(h.state[key]) + Number(value.increment)
          : value;
    }
    return { count: 1 };
  };
  const staffUser = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      matches(where) ? structuredClone(h.state) : null,
    update: async (input: Parameters<typeof update>[0]) => {
      update(input);
      return structuredClone(h.state);
    },
    updateMany: async (input: Parameters<typeof update>[0]) => update(input),
  };
  return {
    prismaOwner: {
      tenant: { findFirst: async () => ({ id: 'tenant' }) },
      staffUser,
      $transaction: async (fn: (tx: unknown) => unknown) => fn({ staffUser }),
    },
  };
});

import { checkPasswordAction, confirmTotpEnrollmentAction } from '../actions';

const NOW = new Date('2026-09-07T00:30:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.generated = 0;
  h.onCompare = () => {};
  h.onHash = () => {};
  h.onGenerate = () => {};
  h.onQr = () => {};
  h.state = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant',
    email: 'staff@example.test',
    passwordHash: 'current-hash',
    authRevision: 0,
    active: true,
    lockedUntil: null,
    hardwareOnlyEnabledAt: null,
    totpSecretEnc: null,
    totpEnrolledAt: null,
    totpSetupStartedAt: null,
  };
});
afterEach(() => vi.useRealTimers());

describe('public TOTP setup cannot overwrite a newer authentication state', () => {
  it('does not reopen enrollment completed while the password was being verified', async () => {
    h.onCompare = () => {
      h.state.totpSecretEnc = 'encrypted:confirmed-secret';
      h.state.totpEnrolledAt = NOW;
      h.state.authRevision = 1;
    };
    const result = await checkPasswordAction('staff@example.test', 'current-password');
    expect(result.setupSecret).toBeUndefined();
    expect(h.state.totpSecretEnc).toBe('encrypted:confirmed-secret');
    expect(h.state.totpEnrolledAt).toEqual(NOW);
  });

  it.each(['password-reset', 'deactivation', 'hardware-only'] as const)(
    'does not create a setup secret after a concurrent %s',
    async (change) => {
      h.onCompare = () => {
        if (change === 'password-reset') {
          h.state.passwordHash = 'new-hash';
          h.state.authRevision = 1;
        }
        if (change === 'deactivation') h.state.active = false;
        if (change === 'hardware-only') {
          h.state.hardwareOnlyEnabledAt = NOW;
          h.state.authRevision = 1;
        }
      };
      const result = await checkPasswordAction('staff@example.test', 'current-password');
      expect(result.ok).toBe(false);
      expect(result.setupSecret).toBeUndefined();
      expect(h.state.totpSecretEnc).toBeNull();
    },
  );

  it('does not disclose a pending secret using a password invalidated during verification', async () => {
    h.state.totpSecretEnc = 'encrypted:pending-secret';
    h.state.totpSetupStartedAt = NOW;
    h.onCompare = () => {
      h.state.passwordHash = 'new-hash';
      h.state.authRevision = 1;
    };
    const result = await checkPasswordAction('staff@example.test', 'current-password');
    expect(result.ok).toBe(false);
    expect(result.setupSecret).toBeUndefined();
  });

  it('also protects the write when enrollment commits after the fresh account read', async () => {
    h.onGenerate = () => {
      h.state.totpSecretEnc = 'encrypted:confirmed-secret';
      h.state.totpEnrolledAt = NOW;
      h.state.authRevision = 1;
    };
    const result = await checkPasswordAction('staff@example.test', 'current-password');
    expect(result.ok).toBe(false);
    expect(result.setupSecret).toBeUndefined();
    expect(h.state.totpSecretEnc).toBe('encrypted:confirmed-secret');
    expect(h.state.totpEnrolledAt).toEqual(NOW);
  });

  it('does not disclose the secret if recovery completes during QR rendering', async () => {
    h.onQr = () => {
      h.state.passwordHash = 'new-hash';
      h.state.authRevision = 1;
    };
    const result = await checkPasswordAction('staff@example.test', 'current-password');
    expect(result.ok).toBe(false);
    expect(result.setupSecret).toBeUndefined();
    expect(result.setupQrDataUrl).toBeUndefined();
  });

  it('allows only one initial secret to win two concurrent setup requests', async () => {
    const results = await Promise.all([
      checkPasswordAction('staff@example.test', 'current-password'),
      checkPasswordAction('staff@example.test', 'current-password'),
    ]);
    const successful = results.filter((result) => result.ok);
    expect(successful).toHaveLength(1);
    expect(h.state.totpSecretEnc).toBe(`encrypted:${successful[0]!.setupSecret}`);
    expect(h.state.totpEnrolledAt).toBeNull();
  });

  it('rejects confirmation after a password reset during backup-code hashing', async () => {
    h.state.totpSecretEnc = 'encrypted:pending-secret';
    h.state.totpSetupStartedAt = NOW;
    h.onHash = () => {
      h.state.passwordHash = 'new-hash';
      h.state.authRevision = 1;
    };
    const result = await confirmTotpEnrollmentAction(
      'staff@example.test',
      'current-password',
      '123456',
    );
    expect(result.ok).toBe(false);
    expect(result.backupCodes).toBeUndefined();
    expect(h.state.totpEnrolledAt).toBeNull();
    expect(h.state.authRevision).toBe(1);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each(['factor-revision', 'hardware-only', 'lockout'] as const)(
    'rejects confirmation after %s changes during backup-code hashing',
    async (change) => {
      h.state.totpSecretEnc = 'encrypted:pending-secret';
      h.state.totpSetupStartedAt = NOW;
      h.onHash = () => {
        if (change === 'factor-revision') h.state.authRevision = 1;
        if (change === 'hardware-only') h.state.hardwareOnlyEnabledAt = NOW;
        if (change === 'lockout') h.state.lockedUntil = new Date(NOW.getTime() + 60_000);
      };
      const result = await confirmTotpEnrollmentAction(
        'staff@example.test',
        'current-password',
        '123456',
      );
      expect(result.ok).toBe(false);
      expect(result.backupCodes).toBeUndefined();
      expect(h.state.totpEnrolledAt).toBeNull();
      expect(h.audit).not.toHaveBeenCalled();
    },
  );

  it('supports normal first setup, reuse, and exactly one confirmation', async () => {
    const first = await checkPasswordAction('staff@example.test', 'current-password');
    expect(first.ok).toBe(true);
    expect(first.setupSecret).toBe('new-secret-1');
    const repeated = await checkPasswordAction('staff@example.test', 'current-password');
    expect(repeated.setupSecret).toBe(first.setupSecret);
    expect(h.generated).toBe(1);
    const confirmed = await confirmTotpEnrollmentAction(
      'staff@example.test',
      'current-password',
      '123456',
    );
    expect(confirmed.ok).toBe(true);
    expect(confirmed.backupCodes).toHaveLength(8);
    expect(h.state.authRevision).toBe(1);
    const again = await confirmTotpEnrollmentAction(
      'staff@example.test',
      'current-password',
      '123456',
    );
    expect(again.ok).toBe(false);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
});
