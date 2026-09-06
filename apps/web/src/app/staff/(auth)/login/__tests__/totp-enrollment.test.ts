// Fachkatalog: ACCESS-TENANT-RLS-001
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  compare: vi.fn(),
  hash: vi.fn(),
  verifyTotpCode: vi.fn(),
  decryptTotpSecret: vi.fn(),
  checkIpOrGlobalLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  checkStaffPasswordAccountLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  resetFailedLogin: vi.fn(),
  recordFailedLoginAudited: vi.fn(),
  evidenceRecord: vi.fn(),
  tenantFindFirst: vi.fn(),
  staffFindFirst: vi.fn(),
  staffUpdateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('bcryptjs', () => ({ default: { compare: m.compare, hash: m.hash } }));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7' })),
}));
vi.mock('next-auth', () => ({ AuthError: class AuthError extends Error {} }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'test-auth-secret' } }));
vi.mock('@/server/auth/totp', () => ({
  generateTotpSecret: vi.fn(),
  buildTotpUri: vi.fn(),
  encryptTotpSecret: vi.fn(),
  decryptTotpSecret: m.decryptTotpSecret,
  verifyTotpCode: m.verifyTotpCode,
}));
vi.mock('@/server/auth/staff', () => ({ staffSignIn: vi.fn(), DEV_SKIP_TOTP: false }));
vi.mock('@/server/auth/lockout', () => ({ resetFailedLogin: m.resetFailedLogin }));
vi.mock('@/server/auth/login-audit', () => ({
  recordFailedLoginAudited: m.recordFailedLoginAudited,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    tenant: { findFirst: m.tenantFindFirst },
    staffUser: { findFirst: m.staffFindFirst },
    $transaction: m.transaction,
  },
}));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: vi.fn(() => '203.0.113.7'),
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  checkRateLimit: m.checkRateLimit,
  checkStaffPasswordAccountLimit: m.checkStaffPasswordAccountLimit,
  resetRateLimit: m.resetRateLimit,
  staffPasswordAccountRateLimitKey: (id: string) => `staff-pw-account:${id}`,
}));

import { checkPasswordAction, confirmTotpEnrollmentAction } from '../actions';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

function staff(overrides: Record<string, unknown> = {}) {
  return {
    id: STAFF_ID,
    tenantId: 'tenant-1',
    email: 'admin@example.test',
    active: true,
    lockedUntil: null,
    passwordHash: 'password-hash',
    totpSecretEnc: 'encrypted-secret',
    totpEnrolledAt: null,
    totpSetupStartedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    hardwareOnlyEnabledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  const allowed = { ok: true, remaining: 4, retryAfter: 0 };
  m.checkIpOrGlobalLimit.mockResolvedValue(allowed);
  m.checkRateLimit.mockResolvedValue(allowed);
  m.checkStaffPasswordAccountLimit.mockResolvedValue(allowed);
  m.tenantFindFirst.mockResolvedValue({ id: 'tenant-1' });
  m.staffFindFirst.mockResolvedValue(staff());
  m.compare.mockResolvedValue(true);
  m.decryptTotpSecret.mockReturnValue('raw-secret');
  m.verifyTotpCode.mockReturnValue(true);
  m.hash.mockResolvedValue('backup-code-hash');
  m.resetFailedLogin.mockResolvedValue(undefined);
  m.staffUpdateMany.mockResolvedValue({ count: 1 });
  m.evidenceRecord.mockResolvedValue({});
  m.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ staffUser: { updateMany: m.staffUpdateMany } }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('confirmTotpEnrollmentAction security gates', () => {
  it('rejects an already enrolled account without rotating backup codes', async () => {
    m.staffFindFirst.mockResolvedValue(staff({ totpEnrolledAt: new Date() }));

    const result = await confirmTotpEnrollmentAction(
      'admin@example.test',
      'correct-password',
      '123456',
    );

    expect(result).toEqual({ ok: false, error: 'TOTP ist bereits eingerichtet.' });
    expect(m.verifyTotpCode).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.resetRateLimit).not.toHaveBeenCalled();
  });

  it('rejects an expired setup before checking the TOTP code', async () => {
    m.staffFindFirst.mockResolvedValue(
      staff({ totpSetupStartedAt: new Date(NOW.getTime() - 61 * 60 * 1000) }),
    );

    const result = await confirmTotpEnrollmentAction(
      'admin@example.test',
      'correct-password',
      '123456',
    );

    expect(result).toEqual({ ok: false, error: 'TOTP-Setup-Fenster abgelaufen.' });
    expect(m.verifyTotpCode).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('does not reset any limiter after an invalid TOTP code', async () => {
    m.verifyTotpCode.mockReturnValue(false);

    const result = await confirmTotpEnrollmentAction(
      'admin@example.test',
      'correct-password',
      '000000',
    );

    expect(result.ok).toBe(false);
    expect(m.checkRateLimit).toHaveBeenCalledWith(`staff-totp-enroll-account:${STAFF_ID}`, {
      max: 5,
      windowSec: 300,
    });
    expect(m.resetRateLimit).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('claims enrollment atomically and resets limits only after success', async () => {
    const result = await confirmTotpEnrollmentAction(
      'admin@example.test',
      'correct-password',
      '123456',
    );

    expect(result.ok).toBe(true);
    expect(result.backupCodes).toHaveLength(8);
    expect(m.staffUpdateMany).toHaveBeenCalledWith({
      where: {
        id: STAFF_ID,
        tenantId: 'tenant-1',
        active: true,
        totpEnrolledAt: null,
        totpSecretEnc: 'encrypted-secret',
        totpSetupStartedAt: { gte: new Date(NOW.getTime() - 60 * 60 * 1000) },
      },
      data: {
        totpEnrolledAt: NOW,
        totpSetupStartedAt: null,
        totpBackupCodes: Array(8).fill('backup-code-hash'),
        authRevision: { increment: 1 },
      },
    });
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    expect(m.resetRateLimit).toHaveBeenCalledWith('staff-pw:203.0.113.7');
    expect(m.resetRateLimit).toHaveBeenCalledWith(`staff-pw-account:${STAFF_ID}`);
    expect(m.resetRateLimit).toHaveBeenCalledWith('staff-totp-enroll:203.0.113.7');
    expect(m.resetRateLimit).toHaveBeenCalledWith(`staff-totp-enroll-account:${STAFF_ID}`);
  });

  it('bietet Hardware-only-Konten keinen Passwort-/TOTP-Enrollment-Fallback an', async () => {
    m.staffFindFirst.mockResolvedValue(staff({ hardwareOnlyEnabledAt: NOW }));

    const result = await confirmTotpEnrollmentAction(
      'admin@example.test',
      'correct-password',
      '123456',
    );

    expect(result).toEqual({ ok: false, error: 'Ungültige Daten.' });
    expect(m.compare).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('loses a concurrent conditional claim without issuing backup codes', async () => {
    m.staffUpdateMany.mockResolvedValue({ count: 0 });

    const result = await confirmTotpEnrollmentAction(
      'admin@example.test',
      'correct-password',
      '123456',
    );

    expect(result).toEqual({
      ok: false,
      error: 'TOTP-Setup wurde bereits abgeschlossen oder geändert.',
    });
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.resetRateLimit).not.toHaveBeenCalled();
  });
});

describe('Hardware-only Passwort-Fallback', () => {
  it('weist bereits den Passwort-Vorschritt generisch und vor bcrypt ab', async () => {
    m.staffFindFirst.mockResolvedValue(staff({ hardwareOnlyEnabledAt: NOW }));

    const result = await checkPasswordAction('admin@example.test', 'correct-password');

    expect(result).toEqual({ ok: false, error: 'Ungültige Anmeldedaten.' });
    expect(m.compare).not.toHaveBeenCalled();
    expect(m.resetFailedLogin).not.toHaveBeenCalled();
  });
});
