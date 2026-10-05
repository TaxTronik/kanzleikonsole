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
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  beginHardwareLogin: vi.fn(),
  tickets: new Map<string, string>(),
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
vi.mock('@/server/logger', () => ({ log: m.log }));
vi.mock('@/server/auth/webauthn', () => ({
  beginHardwareLogin: m.beginHardwareLogin,
  isAuthenticationResponse: vi.fn(),
  isHardwareAccessConfigured: vi.fn(),
}));
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    tenant: { findFirst: m.tenantFindFirst },
    staffUser: { findFirst: m.staffFindFirst },
    $transaction: m.transaction,
  },
}));
// R-04: zustandsbehafteter Redis-Double für die Einmal-Tickets.
vi.mock('@/server/redis', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => {
      m.tickets.set(key, value);
      return 'OK';
    },
    getdel: async (key: string) => {
      const value = m.tickets.get(key) ?? null;
      m.tickets.delete(key);
      return value;
    },
  }),
}));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: vi.fn(() => '203.0.113.7'),
  checkIpOrGlobalLimit: m.checkIpOrGlobalLimit,
  checkRateLimit: m.checkRateLimit,
  checkStaffPasswordAccountLimit: m.checkStaffPasswordAccountLimit,
  resetRateLimit: m.resetRateLimit,
  staffPasswordAccountRateLimitKey: (id: string) => `staff-pw-account:${id}`,
}));

import {
  beginHardwareLoginAction,
  checkPasswordAction,
  confirmTotpEnrollmentAction,
} from '../actions';
import { DUMMY_PASSWORD_HASH } from '@/server/auth/staff-password';
import {
  issueStaffLoginTicket,
  type StaffLoginTicketPurpose,
} from '@/server/auth/staff-login-ticket';

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
    authRevision: 0,
    totpSecretEnc: 'encrypted-secret',
    totpEnrolledAt: null,
    totpSetupStartedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    hardwareOnlyEnabledAt: null,
    ...overrides,
  };
}

/** Ticket des Passwortschritts für den Stand von staff() (R-04). */
function ticket(purpose: StaffLoginTicketPurpose = 'totp-enrollment') {
  return issueStaffLoginTicket(purpose, {
    id: STAFF_ID,
    tenantId: 'tenant-1',
    authRevision: 0,
    passwordHash: 'password-hash',
  });
}

function storedTickets() {
  return [...m.tickets.values()].map((value) => JSON.parse(value) as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers();
  m.tickets.clear();
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

    const result = await confirmTotpEnrollmentAction(await ticket(), '123456');

    expect(result).toEqual({ ok: false, error: 'TOTP ist bereits eingerichtet.' });
    expect(m.verifyTotpCode).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.resetRateLimit).not.toHaveBeenCalled();
  });

  it('rejects an expired setup before checking the TOTP code', async () => {
    m.staffFindFirst.mockResolvedValue(
      staff({ totpSetupStartedAt: new Date(NOW.getTime() - 61 * 60 * 1000) }),
    );

    const result = await confirmTotpEnrollmentAction(await ticket(), '123456');

    expect(result).toEqual({ ok: false, error: 'TOTP-Setup-Fenster abgelaufen.' });
    expect(m.verifyTotpCode).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('does not reset any limiter after an invalid TOTP code', async () => {
    m.verifyTotpCode.mockReturnValue(false);

    const result = await confirmTotpEnrollmentAction(await ticket(), '000000');

    expect(result.ok).toBe(false);
    expect(m.checkRateLimit).toHaveBeenCalledWith(`staff-totp-enroll-account:${STAFF_ID}`, {
      max: 5,
      windowSec: 300,
    });
    expect(m.resetRateLimit).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('claims enrollment atomically and resets limits only after success', async () => {
    const result = await confirmTotpEnrollmentAction(await ticket(), '123456');

    expect(result.ok).toBe(true);
    expect(result.backupCodes).toHaveLength(8);
    expect(m.staffUpdateMany).toHaveBeenCalledWith({
      where: {
        id: STAFF_ID,
        tenantId: 'tenant-1',
        passwordHash: 'password-hash',
        authRevision: 0,
        active: true,
        hardwareOnlyEnabledAt: null,
        totpEnrolledAt: null,
        totpSecretEnc: 'encrypted-secret',
        totpSetupStartedAt: { gte: new Date(NOW.getTime() - 60 * 60 * 1000) },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: NOW } }],
      },
      data: {
        totpEnrolledAt: NOW,
        totpSetupStartedAt: null,
        totpBackupCodes: Array(8).fill('backup-code-hash'),
        authRevision: { increment: 1 },
      },
    });
    expect(m.evidenceRecord).toHaveBeenCalledTimes(1);
    // R-04: Das Enrollment prüft kein Passwort mehr; die Passwort-Buckets hat
    // bereits der Passwortschritt geleert.
    expect(m.resetRateLimit.mock.calls).toEqual([
      ['staff-totp-enroll:203.0.113.7'],
      [`staff-totp-enroll-account:${STAFF_ID}`],
    ]);
    expect(m.compare).not.toHaveBeenCalled();
    // Neues Ticket für den TOTP-Login, gebunden an die erhöhte Revision.
    expect(result.loginTicket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedTickets()).toEqual([
      expect.objectContaining({ purpose: 'second-factor', staffId: STAFF_ID, authRevision: 1 }),
    ]);
  });

  it('löst jedes Ticket nur einmal und nur für das Erst-Setup ein', async () => {
    const enrollment = await ticket();
    m.verifyTotpCode.mockReturnValue(false);
    await expect(confirmTotpEnrollmentAction(enrollment, '000000')).resolves.toMatchObject({
      ok: false,
    });
    m.verifyTotpCode.mockReturnValue(true);
    await expect(confirmTotpEnrollmentAction(enrollment, '123456')).resolves.toEqual({
      ok: false,
      error: 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.',
    });
    await expect(
      confirmTotpEnrollmentAction(await ticket('second-factor'), '123456'),
    ).resolves.toEqual({
      ok: false,
      error: 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.',
    });
    await expect(confirmTotpEnrollmentAction('x'.repeat(43), '123456')).resolves.toMatchObject({
      ok: false,
    });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('bietet Hardware-only-Konten keinen Passwort-/TOTP-Enrollment-Fallback an', async () => {
    m.staffFindFirst.mockResolvedValue(staff({ hardwareOnlyEnabledAt: NOW }));

    const result = await confirmTotpEnrollmentAction(await ticket(), '123456');

    // R-04: Das Ticket gilt nur für den Passwortmodus, in dem es entstand.
    expect(result).toEqual({
      ok: false,
      error: 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.',
    });
    expect(m.compare).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it('loses a concurrent conditional claim without issuing backup codes', async () => {
    m.staffUpdateMany.mockResolvedValue({ count: 0 });

    const result = await confirmTotpEnrollmentAction(await ticket(), '123456');

    expect(result).toEqual({
      ok: false,
      error: 'TOTP-Setup wurde bereits abgeschlossen oder geändert.',
    });
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.resetRateLimit).not.toHaveBeenCalled();
  });
});

describe('Hardware-only Passwort-Fallback', () => {
  it('weist bereits den Passwort-Vorschritt generisch und nur gegen den Dummy-Hash ab', async () => {
    m.staffFindFirst.mockResolvedValue(staff({ hardwareOnlyEnabledAt: NOW }));

    const result = await checkPasswordAction('admin@example.test', 'correct-password');

    expect(result).toEqual({ ok: false, error: 'Ungültige Anmeldedaten.' });
    // S-09: gleiche Rechenzeit wie ein falsches Passwort, aber kein Kontohash.
    expect(m.compare).toHaveBeenCalledExactlyOnceWith('correct-password', DUMMY_PASSWORD_HASH);
    expect(m.resetFailedLogin).not.toHaveBeenCalled();
  });
});

describe('F-05 failed-login bookkeeping errors', () => {
  it('keeps the generic password result but logs a lost lockout count', async () => {
    m.compare.mockResolvedValue(false);
    m.recordFailedLoginAudited.mockRejectedValue(new Error('database unavailable'));

    const result = await checkPasswordAction('admin@example.test', 'wrong-password');

    expect(result).toEqual({ ok: false, error: 'Ungültige Anmeldedaten.' });
    expect(m.log.error).toHaveBeenCalledWith(
      {
        component: 'staff-login',
        tenantId: 'tenant-1',
        staffId: STAFF_ID,
        reason: 'password',
        err: 'database unavailable',
      },
      'staff-login: Fehlversuch weder gezählt noch auditiert (Lockout-Zähler)',
    );
  });

  it('logs a failed counter reset after a successful enrollment without failing it', async () => {
    m.resetFailedLogin.mockRejectedValue(new Error('redis down'));

    const result = await confirmTotpEnrollmentAction(await ticket(), '123456');
    await vi.waitFor(() =>
      expect(m.log.warn).toHaveBeenCalledWith(
        { label: 'staff-login: resetFailedLogin', err: 'redis down' },
        'fire-and-forget failed',
      ),
    );

    expect(result.ok).toBe(true);
  });

  it('logs why a security-key login could not be started', async () => {
    m.beginHardwareLogin.mockRejectedValue(new Error('WebAuthn RP-ID fehlt'));

    const result = await beginHardwareLoginAction();

    expect(result).toEqual({ error: 'Sicherheitsschlüssel sind derzeit nicht verfügbar.' });
    expect(m.log.error).toHaveBeenCalledWith(
      { component: 'staff-login', err: 'WebAuthn RP-ID fehlt' },
      'staff-login: Sicherheitsschlüssel-Anmeldung konnte nicht gestartet werden',
    );
  });
});
