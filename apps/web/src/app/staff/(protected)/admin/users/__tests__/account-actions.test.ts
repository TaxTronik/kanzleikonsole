import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const RECOVERY_STEP_UP_FAILED =
  'Die zusätzliche Identitätsbestätigung ist ungültig oder abgelaufen.';
const mocks = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    dbNull: Symbol('DbNull'),
    ActionError,
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    hash: vi.fn(),
    compare: vi.fn(),
    evidenceRecord: vi.fn(),
    revokeAllSessions: vi.fn(),
    lockStaffAccountRecovery: vi.fn(),
    revokeStaffHardwareCredentialsForRecovery: vi.fn(),
    revokeStaffHardwareCredentialsForSecurityReset: vi.fn(),
    decryptTotpSecret: vi.fn(),
    verifyTotpCode: vi.fn(),
    consumeTotpCode: vi.fn(),
    checkRateLimit: vi.fn(),
    beginHardwareModeAssertion: vi.fn(),
    consumeHardwareCeremony: vi.fn(),
    verifyHardwareAssertion: vi.fn(),
    lockMatchingHardwareMetadataSerial: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('bcryptjs', () => ({ compare: mocks.compare, hash: mocks.hash }));
vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'test-auth-secret' } }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({
  Prisma: { DbNull: mocks.dbNull },
  withTenantContext: mocks.withTenantContext,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rss/defaults', () => ({ seedDefaultRssFeeds: vi.fn() }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: mocks.revokeAllSessions }));
vi.mock('@/server/auth/staff-account-recovery-lock', () => ({
  lockStaffAccountRecovery: mocks.lockStaffAccountRecovery,
  revokeStaffHardwareCredentialsForRecovery: mocks.revokeStaffHardwareCredentialsForRecovery,
  revokeStaffHardwareCredentialsForSecurityReset:
    mocks.revokeStaffHardwareCredentialsForSecurityReset,
}));
vi.mock('@/server/auth/totp', () => ({
  decryptTotpSecret: mocks.decryptTotpSecret,
  verifyTotpCode: mocks.verifyTotpCode,
}));
vi.mock('@/server/auth/totp-replay', () => ({ consumeTotpCode: mocks.consumeTotpCode }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/server/auth/webauthn', () => {
  class HardwareAccessUnavailableError extends Error {}
  class HardwareAccessVerificationError extends Error {}
  return {
    beginHardwareModeAssertion: mocks.beginHardwareModeAssertion,
    consumeHardwareCeremony: mocks.consumeHardwareCeremony,
    HardwareAccessUnavailableError,
    HardwareAccessVerificationError,
    isAuthenticationResponse: (value: unknown) => Boolean(value),
    lockMatchingHardwareMetadataSerial: mocks.lockMatchingHardwareMetadataSerial,
    verifyHardwareAssertion: mocks.verifyHardwareAssertion,
  };
});
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: mocks.ActionError,
  staffActionGuard: mocks.staffActionGuard,
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Aktion fehlgeschlagen.',
  }),
}));

import {
  beginHardwareRecoveryStepUpAction,
  createUserAction,
  recoverHardwareAccessAction,
  resetPasswordAction,
  resetTotpAction,
  setActiveAction,
  setRolesAction,
  setProfessionalProfileAction,
} from '../actions';

function guardFor(roles: string[], staffId = ADMIN_ID) {
  return {
    ok: true,
    tenantId: TENANT_ID,
    staffId,
    session: { user: { roles } },
    ctx: { tenantId: TENANT_ID, actorId: staffId, actorType: 'STAFF' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue(guardFor(['ADMIN']));
  mocks.hash.mockResolvedValue('new-password-hash');
  mocks.compare.mockResolvedValue(true);
  mocks.revokeAllSessions.mockResolvedValue(undefined);
  mocks.lockStaffAccountRecovery.mockResolvedValue(undefined);
  mocks.revokeStaffHardwareCredentialsForRecovery.mockResolvedValue(2);
  mocks.revokeStaffHardwareCredentialsForSecurityReset.mockResolvedValue(1);
  mocks.decryptTotpSecret.mockReturnValue('totp-secret');
  mocks.verifyTotpCode.mockReturnValue(true);
  mocks.consumeTotpCode.mockResolvedValue(true);
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 4, retryAfter: 0 });
  mocks.beginHardwareModeAssertion.mockResolvedValue({
    ceremonyId: 'a'.repeat(32),
    options: { challenge: 'challenge' },
  });
  mocks.consumeHardwareCeremony.mockResolvedValue({
    version: 1,
    purpose: 'admin-recovery',
    challenge: 'challenge',
    origin: 'https://example.test',
    rpID: 'example.test',
  });
  mocks.verifyHardwareAssertion.mockResolvedValue({ newSignCount: 7n, metadataSerial: 7n });
  mocks.lockMatchingHardwareMetadataSerial.mockResolvedValue(undefined);
});

describe('ACCESS-STAFF-PERMISSION-001 / GWG-RISK-REVIEW-001: professional profile', () => {
  function transaction() {
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          isProfessional: true,
          datevAdvisorNumber: '00123',
          professionalQualificationSource: 'legacy',
          roles: [{ role: 'EMPLOYEE' }],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      client: {
        findMany: vi.fn().mockResolvedValue([{ id: 'client-1', name: 'Mandat ohne Nachfolger' }]),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (value: typeof tx) => unknown) => fn(tx),
    );
    return tx;
  }
  it('requires admin management permission before reading or changing qualification', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce({ ok: false, error: 'Nur ADMIN/PARTNER.' });
    const result = await setProfessionalProfileAction({
      userId: USER_ID,
      isProfessional: true,
      datevAdvisorNumber: '',
    });
    expect(result.ok).toBe(false);
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });
  it('retains leading zeroes and does not add roles when confirming a legacy qualification', async () => {
    const tx = transaction();
    const result = await setProfessionalProfileAction({
      userId: USER_ID,
      isProfessional: true,
      datevAdvisorNumber: ' 00123 ',
    });
    expect(result).toEqual({ ok: true, assignmentGaps: [] });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          isProfessional: true,
          datevAdvisorNumber: '00123',
          professionalQualificationSource: 'manual',
        },
      }),
    );
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.professional_profile.update',
        after: {
          isProfessional: true,
          datevAdvisorNumber: '00123',
          professionalQualificationSource: 'manual',
        },
      }),
    );
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });
  it('revokes sessions before qualification removal and reports gaps without deleting assignments or historical approvals', async () => {
    const tx = transaction();
    const result = await setProfessionalProfileAction({
      userId: USER_ID,
      isProfessional: false,
      datevAdvisorNumber: '',
    });
    expect(result).toEqual({
      ok: true,
      assignmentGaps: [{ id: 'client-1', name: 'Mandat ohne Nachfolger' }],
    });
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', USER_ID);
    expect(mocks.revokeAllSessions.mock.invocationCallOrder[0]).toBeLessThan(
      tx.staffUser.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_ID, AND: expect.any(Array) }),
      }),
    );
  });
  it('rejects a stale update and does not write an audit success', async () => {
    const tx = transaction();
    tx.staffUser.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await setProfessionalProfileAction({
      userId: USER_ID,
      isProfessional: true,
      datevAdvisorNumber: '44',
    });
    expect(result.ok).toBe(false);
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
  it('keeps partner restrictions on management of admin accounts', async () => {
    const tx = transaction();
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    tx.staffUser.findFirst.mockResolvedValueOnce({
      isProfessional: true,
      datevAdvisorNumber: '00123',
      professionalQualificationSource: 'legacy',
      roles: [{ role: 'ADMIN' }],
    });
    expect(
      (
        await setProfessionalProfileAction({
          userId: USER_ID,
          isProfessional: false,
          datevAdvisorNumber: '',
        })
      ).ok,
    ).toBe(false);
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
  });
});

describe('resetPasswordAction', () => {
  it('prüft Admin-Rechte vor bcrypt', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce({ ok: false, error: 'Nur ADMIN/PARTNER.' });

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({ ok: false, error: 'Nur ADMIN/PARTNER.' });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });

  it('setzt das Passwort ohne Geheimnisse im Audit und widerruft alle Sitzungen', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          roles: [{ role: 'EMPLOYEE' }],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        roles: { none: { role: { in: ['ADMIN'] } } },
        hardwareOnlyEnabledAt: null,
      },
      data: {
        passwordHash: 'new-password-hash',
        failedLoginCount: 0,
        lockedUntil: null,
        authRevision: { increment: 1 },
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.password.reset',
        actorId: ADMIN_ID,
        resourceId: USER_ID,
        after: { changedBy: 'admin', revokedHardwareKeys: 1 },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('Neues-Passwort-2026!');
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('new-password-hash');
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.revokeStaffHardwareCredentialsForSecurityReset).toHaveBeenCalledWith(
      tx,
      USER_ID,
      0,
    );
  });

  it('bindet den Passwort-Reset unabhängig von Redis an die Auth-Revision', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          roles: [{ role: 'EMPLOYEE' }],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.revokeAllSessions.mockRejectedValueOnce(
      new Error('Session-Widerruf ist derzeit nicht verfügbar.'),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authRevision: { increment: 1 } }),
      }),
    );
    expect(mocks.evidenceRecord).toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verweist für das eigene Passwort auf das Benutzerprofil', async () => {
    const result = await resetPasswordAction({
      userId: ADMIN_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Das eigene Passwort bitte im Benutzerprofil ändern.',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('bricht atomar ab, wenn das Ziel während des Passwort-Resets zum ADMIN wird', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          roles: [{ role: 'EMPLOYEE' }],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Kontorollen wurden parallel geändert; Reset abgebrochen.',
    });
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verwehrt einem PARTNER den Passwort-Reset eines ADMIN-Kontos', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          roles: [{ role: 'EMPLOYEE' }, { role: 'ADMIN' }],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({
      ok: false,
      error: 'ADMIN-Konten können nur über die Administrations-CLI zurückgesetzt werden.',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verwehrt auch einem ADMIN den Web-Reset eines anderen ADMIN-Kontos', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          roles: [{ role: 'ADMIN' }],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({
      ok: false,
      error: 'ADMIN-Konten können nur über die Administrations-CLI zurückgesetzt werden.',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('verwehrt einem PARTNER den Passwort-Reset eines anderen PARTNER-Kontos', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          roles: [{ role: 'EMPLOYEE' }, { role: 'PARTNER' }],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Neues-Passwort-2026!',
      confirmPassword: 'Neues-Passwort-2026!',
    });

    expect(result).toEqual({
      ok: false,
      error: 'PARTNER-Konten können nur durch einen ADMIN zurückgesetzt werden.',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it.each([
    { actor: 'ADMIN', target: 'PARTNER', protectedRoles: ['ADMIN'] },
    { actor: 'PARTNER', target: 'EMPLOYEE', protectedRoles: ['ADMIN', 'PARTNER'] },
  ])(
    'erlaubt $actor den vorgesehenen Passwort-Reset für $target',
    async ({ actor, target, protectedRoles }) => {
      mocks.staffActionGuard.mockResolvedValueOnce(guardFor([actor]));
      const tx = {
        staffUser: {
          findUnique: vi.fn().mockResolvedValue({
            id: USER_ID,
            roles: [{ role: target }],
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      mocks.withTenantContext.mockImplementation(
        async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
      );

      const result = await resetPasswordAction({
        userId: USER_ID,
        password: 'Neues-Passwort-2026!',
        confirmPassword: 'Neues-Passwort-2026!',
      });

      expect(result).toEqual({ ok: true });
      expect(tx.staffUser.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: USER_ID,
            roles: { none: { role: { in: protectedRoles } } },
            hardwareOnlyEnabledAt: null,
          },
        }),
      );
    },
  );
});

describe('createUserAction', () => {
  it('verlangt auch beim Initial-Passwort eine übereinstimmende Wiederholung', async () => {
    const formData = new FormData();
    formData.set('fullName', 'Neue Mitarbeiterin');
    formData.set('email', 'neu@example.test');
    formData.set('password', 'Initial-Passwort-2026!');
    formData.set('confirmPassword', 'Abweichendes-Passwort!');

    const result = await createUserAction(null, formData);

    expect(result).toEqual({ ok: false, error: 'Die Passwörter stimmen nicht überein.' });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });

  it('verhindert, dass ein PARTNER einen ADMIN-Benutzer anlegt', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    const formData = new FormData();
    formData.set('fullName', 'Unzulässiger Admin');
    formData.set('email', 'admin-neu@example.test');
    formData.set('password', 'Initial-Passwort-2026!');
    formData.set('confirmPassword', 'Initial-Passwort-2026!');
    formData.set('role.ADMIN', 'on');

    const result = await createUserAction(null, formData);

    expect(result).toEqual({
      ok: false,
      error: 'Die ADMIN-Rolle kann nur durch einen ADMIN vergeben werden.',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });
});

describe('resetTotpAction', () => {
  it('löscht Secret, Enrollment und Backup-Codes atomar und widerruft Sitzungen', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          roles: [{ role: 'EMPLOYEE' }],
          totpEnrolledAt: new Date('2026-08-21T12:00:00.000Z'),
          totpSecretEnc: 'encrypted-secret',
          totpSetupStartedAt: null,
          totpBackupCodes: ['hashed-backup-code'],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetTotpAction({ userId: USER_ID });

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        roles: { none: { role: { in: ['ADMIN'] } } },
        hardwareOnlyEnabledAt: null,
      },
      data: {
        totpSecretEnc: null,
        totpEnrolledAt: null,
        totpSetupStartedAt: null,
        totpBackupCodes: mocks.dbNull,
        authRevision: { increment: 1 },
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.totp.reset',
        before: { enrolled: true, setupPending: false },
        after: { enrolled: false, setupPending: false, revokedHardwareKeys: 1 },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('encrypted-secret');
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.revokeStaffHardwareCredentialsForSecurityReset).toHaveBeenCalledWith(
      tx,
      USER_ID,
      0,
    );
  });

  it('bindet den 2FA-Reset unabhängig von Redis an die Auth-Revision', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          roles: [{ role: 'EMPLOYEE' }],
          totpEnrolledAt: new Date('2026-08-21T12:00:00.000Z'),
          totpSecretEnc: 'encrypted-secret',
          totpSetupStartedAt: null,
          totpBackupCodes: ['hashed-backup-code'],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.revokeAllSessions.mockRejectedValueOnce(
      new Error('Session-Widerruf ist derzeit nicht verfügbar.'),
    );

    const result = await resetTotpAction({ userId: USER_ID });

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authRevision: { increment: 1 } }),
      }),
    );
    expect(mocks.evidenceRecord).toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verhindert den eigenen 2FA-Reset', async () => {
    const result = await resetTotpAction({ userId: ADMIN_ID });

    expect(result).toEqual({
      ok: false,
      error: 'ADMIN-Konten können nur über die Administrations-CLI zurückgesetzt werden.',
    });
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verwehrt einem PARTNER den 2FA-Reset eines ADMIN-Kontos', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          roles: [{ role: 'ADMIN' }],
          totpEnrolledAt: new Date('2026-08-21T12:00:00.000Z'),
          totpSecretEnc: 'encrypted-secret',
          totpSetupStartedAt: null,
          totpBackupCodes: [],
        }),
        updateMany: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetTotpAction({ userId: USER_ID });

    expect(result).toEqual({
      ok: false,
      error: 'ADMIN-Konten können nur über die Administrations-CLI zurückgesetzt werden.',
    });
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });
});

// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001
describe('Hardware-Zugang-Recovery', () => {
  const actorTotpEnrolledAt = new Date('2026-09-01T08:00:00.000Z');
  const passwordStepUpActor = {
    authRevision: 3,
    passwordHash: 'actor-password-hash',
    hardwareOnlyEnabledAt: null,
    totpSecretEnc: 'actor-totp-secret-encrypted',
    totpEnrolledAt: actorTotpEnrolledAt,
    hardwareCredentials: [],
  };
  const hardwareEnabledAt = new Date('2026-09-02T08:00:00.000Z');
  const hardwareCredential = {
    id: 'actor-key-db-id',
    credentialId: 'actor-credential-id-long-enough',
    aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    publicKey: new Uint8Array([1, 2, 3]),
    signCount: 6n,
    webauthnUserId: Buffer.from(ADMIN_ID, 'utf8').toString('base64url'),
    transports: ['usb'],
    deviceType: 'singleDevice',
    backedUp: false,
    attestationFormat: 'packed',
    attestationVerifiedAt: new Date('2026-09-01T08:00:00.000Z'),
    authenticatorVersion: 42n,
  };
  const hardwareStepUpActor = {
    authRevision: 5,
    passwordHash: 'unused-actor-password-hash',
    hardwareOnlyEnabledAt: hardwareEnabledAt,
    totpSecretEnc: 'unused-actor-totp-secret',
    totpEnrolledAt: actorTotpEnrolledAt,
    hardwareCredentials: [hardwareCredential],
  };
  const hardwareResponse: AuthenticationResponseJSON = {
    id: hardwareCredential.credentialId,
    rawId: hardwareCredential.credentialId,
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'client-data',
      authenticatorData: 'authenticator-data',
      signature: 'signature',
      userHandle: hardwareCredential.webauthnUserId,
    },
  };

  it('verhindert den normalen Passwort-Reset als Hardware-only-Fallback', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          hardwareOnlyEnabledAt: new Date('2026-09-03T10:00:00.000Z'),
          roles: [{ role: 'EMPLOYEE' }],
        }),
        updateMany: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetPasswordAction({
      userId: USER_ID,
      password: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Für dieses Konto ist „Nur Sicherheitsschlüssel“ aktiv. Verwenden Sie „Hardware-Zugang wiederherstellen“.',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
  });

  it('bindet die Hardware-Step-up-Challenge an Actor, Zielkonto und Auth-Revision', async () => {
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(hardwareStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: new Date('2026-09-03T10:00:00.000Z'),
            roles: [{ role: 'EMPLOYEE' }],
          }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await beginHardwareRecoveryStepUpAction({ targetUserId: USER_ID });

    expect(result).toEqual({ ceremonyId: 'a'.repeat(32), options: { challenge: 'challenge' } });
    expect(mocks.beginHardwareModeAssertion).toHaveBeenCalledWith({
      purpose: 'admin-recovery',
      staffId: ADMIN_ID,
      tenantId: TENANT_ID,
      targetStaffId: USER_ID,
      authRevision: 5,
      credentials: [hardwareCredential],
    });
  });

  it('verlangt beim Passwortmodus aktuelles Passwort und frischen TOTP statt Session allein', async () => {
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(passwordStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: new Date('2026-09-03T10:00:00.000Z'),
            roles: [{ role: 'EMPLOYEE' }],
          }),
        updateMany: vi.fn(),
      },
      staffWebAuthnCredential: { updateMany: vi.fn() },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.compare.mockResolvedValueOnce(false);

    const result = await recoverHardwareAccessAction({
      targetUserId: USER_ID,
      newPassword: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
      actorPassword: 'falsch',
      actorTotpCode: '123456',
    });

    expect(result).toEqual({ ok: false, error: RECOVERY_STEP_UP_FAILED });
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.revokeStaffHardwareCredentialsForRecovery).not.toHaveBeenCalled();
  });

  it('lehnt einen bereits verbrauchten TOTP-Code im Step-up fail-closed ab', async () => {
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(passwordStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: new Date('2026-09-03T10:00:00.000Z'),
            roles: [{ role: 'EMPLOYEE' }],
          }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.consumeTotpCode.mockResolvedValueOnce(false);

    const result = await recoverHardwareAccessAction({
      targetUserId: USER_ID,
      newPassword: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
      actorPassword: 'Aktuelles-Admin-Passwort!',
      actorTotpCode: '123456',
    });

    expect(result).toEqual({ ok: false, error: RECOVERY_STEP_UP_FAILED });
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('setzt Hardware-only atomar auf neues Passwort plus offenes TOTP-Setup zurück', async () => {
    const enabledAt = new Date('2026-09-03T10:00:00.000Z');
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(passwordStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: enabledAt,
            roles: [{ role: 'EMPLOYEE' }],
          })
          .mockResolvedValueOnce(passwordStepUpActor),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffWebAuthnCredential: { updateMany: vi.fn() },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await recoverHardwareAccessAction({
      targetUserId: USER_ID,
      newPassword: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
      actorPassword: 'Aktuelles-Admin-Passwort!',
      actorTotpCode: '123456',
    });

    expect(result).toEqual({ ok: true });
    // Fachkatalog: ACCESS-TENANT-RLS-001 — authRevision ist der atomare
    // Session-Cutoff; ein vorgezogener Redis-Revoke dürfte bei Tx-Rollback
    // keinen rollenübergreifenden Logout-DoS hinterlassen.
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        tenantId: TENANT_ID,
        hardwareOnlyEnabledAt: { not: null },
        roles: { none: { role: { in: ['ADMIN'] } } },
      },
      data: {
        passwordHash: 'new-password-hash',
        hardwareOnlyEnabledAt: null,
        totpSecretEnc: null,
        totpEnrolledAt: null,
        totpSetupStartedAt: null,
        totpBackupCodes: mocks.dbNull,
        failedLoginCount: 0,
        lockedUntil: null,
        authRevision: { increment: 1 },
      },
    });
    expect(mocks.revokeStaffHardwareCredentialsForRecovery).toHaveBeenCalledWith(tx, USER_ID);
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.hardware_access.reset',
        actorId: ADMIN_ID,
        resourceId: USER_ID,
        before: { mode: 'hardware_only', activeSecurityKeys: 2 },
        after: {
          mode: 'password_totp_setup_required',
          activeSecurityKeys: 0,
          changedBy: 'admin',
          stepUpMethod: 'password_totp',
        },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain(
      'Recovery-Passwort-2026!',
    );
    expect(
      mocks.revokeStaffHardwareCredentialsForRecovery.mock.invocationCallOrder[0]!,
    ).toBeLessThan(tx.staffUser.updateMany.mock.invocationCallOrder[0]!);
    expect(mocks.lockStaffAccountRecovery).not.toHaveBeenCalled();
  });

  it('verifiziert für einen Hardware-only-Actor dessen eigenen Schlüssel und schreibt den Counter atomar', async () => {
    const enabledAt = new Date('2026-09-03T10:00:00.000Z');
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(hardwareStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: enabledAt,
            roles: [{ role: 'EMPLOYEE' }],
          })
          .mockResolvedValueOnce(hardwareStepUpActor),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffWebAuthnCredential: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await recoverHardwareAccessAction({
      targetUserId: USER_ID,
      newPassword: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
      ceremonyId: 'a'.repeat(32),
      response: hardwareResponse,
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.consumeHardwareCeremony).toHaveBeenCalledWith({
      ceremonyId: 'a'.repeat(32),
      purpose: 'admin-recovery',
      staffId: ADMIN_ID,
      tenantId: TENANT_ID,
      targetStaffId: USER_ID,
      authRevision: 5,
    });
    expect(mocks.verifyHardwareAssertion).toHaveBeenCalledWith(
      expect.objectContaining({
        response: hardwareResponse,
        staffId: ADMIN_ID,
        credential: expect.objectContaining({
          id: hardwareCredential.credentialId,
          aaguid: hardwareCredential.aaguid,
          signCount: 6n,
          authenticatorVersion: 42n,
        }),
      }),
    );
    expect(tx.staffWebAuthnCredential.updateMany).toHaveBeenCalledWith({
      where: {
        id: hardwareCredential.id,
        tenantId: TENANT_ID,
        staffUserId: ADMIN_ID,
        revokedAt: null,
        signCount: 6n,
      },
      data: { signCount: 7n, lastUsedAt: expect.any(Date) },
    });
    expect(mocks.lockMatchingHardwareMetadataSerial).toHaveBeenCalledWith(tx, 7n);
    expect(mocks.revokeStaffHardwareCredentialsForRecovery).toHaveBeenCalledWith(tx, USER_ID);
    expect(mocks.lockMatchingHardwareMetadataSerial.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.revokeStaffHardwareCredentialsForRecovery.mock.invocationCallOrder[0]!,
    );
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        after: expect.objectContaining({ stepUpMethod: 'security_key' }),
      }),
    );
  });

  it('rollt nach dem DB-Lock zurück, wenn sich die Auth-Revision des Actors geändert hat', async () => {
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(passwordStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: new Date('2026-09-03T10:00:00.000Z'),
            roles: [{ role: 'EMPLOYEE' }],
          })
          .mockResolvedValueOnce({ ...passwordStepUpActor, authRevision: 4 }),
        updateMany: vi.fn(),
      },
      staffWebAuthnCredential: { updateMany: vi.fn() },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await recoverHardwareAccessAction({
      targetUserId: USER_ID,
      newPassword: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
      actorPassword: 'Aktuelles-Admin-Passwort!',
      actorTotpCode: '123456',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Ihr Anmeldezustand wurde geändert; Recovery abgebrochen.',
    });
    expect(mocks.revokeStaffHardwareCredentialsForRecovery).toHaveBeenCalledWith(tx, USER_ID);
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('rollt die Recovery bei einem inkonsistenten Credential-Bestand zurueck', async () => {
    const enabledAt = new Date('2026-09-03T10:00:00.000Z');
    const tx = {
      staffUser: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(passwordStepUpActor)
          .mockResolvedValueOnce({
            hardwareOnlyEnabledAt: enabledAt,
            roles: [{ role: 'EMPLOYEE' }],
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffWebAuthnCredential: { updateMany: vi.fn() },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.revokeStaffHardwareCredentialsForRecovery.mockResolvedValueOnce(1);

    const result = await recoverHardwareAccessAction({
      targetUserId: USER_ID,
      newPassword: 'Recovery-Passwort-2026!',
      confirmPassword: 'Recovery-Passwort-2026!',
      actorPassword: 'Aktuelles-Admin-Passwort!',
      actorTotpCode: '123456',
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Der Hardware-Zugang enthält nicht die erforderlichen Sicherheitsschlüssel; Recovery abgebrochen.',
    });
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });
});

describe('ADMIN-Rollenhierarchie', () => {
  it('verhindert, dass ein PARTNER einen ADMIN deaktiviert', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          active: true,
          roles: [{ role: 'ADMIN' }],
        }),
        update: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await setActiveAction({ userId: USER_ID, active: false });

    expect(result).toEqual({
      ok: false,
      error: 'ADMIN-Konten können nur durch einen ADMIN verwaltet werden.',
    });
    expect(tx.staffUser.update).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verhindert ADMIN-Vergabe und Änderungen bestehender ADMIN-Rollen durch PARTNER', async () => {
    mocks.staffActionGuard.mockResolvedValue(guardFor(['PARTNER']));
    const tx = {
      staffRole: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    tx.staffRole.findMany.mockResolvedValueOnce([{ role: 'EMPLOYEE' }]);
    const grantResult = await setRolesAction({
      userId: USER_ID,
      roles: ['EMPLOYEE', 'ADMIN'],
    });
    expect(grantResult).toEqual({
      ok: false,
      error: 'Die ADMIN-Rolle kann nur durch einen ADMIN verwaltet werden.',
    });

    tx.staffRole.findMany.mockResolvedValueOnce([{ role: 'EMPLOYEE' }, { role: 'ADMIN' }]);
    const removeResult = await setRolesAction({ userId: USER_ID, roles: ['EMPLOYEE'] });
    expect(removeResult).toEqual({
      ok: false,
      error: 'Die ADMIN-Rolle kann nur durch einen ADMIN verwaltet werden.',
    });

    expect(tx.staffRole.deleteMany).not.toHaveBeenCalled();
    expect(tx.staffRole.create).not.toHaveBeenCalled();
    expect(mocks.lockStaffAccountRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.lockStaffAccountRecovery.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.staffRole.findMany.mock.invocationCallOrder[0]!,
    );
  });

  it('verhindert auch für ADMIN den Web-Entzug einer bestehenden ADMIN-Rolle', async () => {
    const tx = {
      staffRole: {
        findMany: vi.fn().mockResolvedValue([{ role: 'ADMIN' }, { role: 'EMPLOYEE' }]),
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await setRolesAction({ userId: USER_ID, roles: ['EMPLOYEE'] });

    expect(result).toEqual({
      ok: false,
      error: 'Die ADMIN-Rolle darf in der Web-Oberfläche nicht entzogen werden.',
    });
    expect(tx.staffRole.deleteMany).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('verhindert, dass ein PARTNER die Recovery-Hierarchie per PARTNER-Entzug umgeht', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce(guardFor(['PARTNER']));
    const tx = {
      staffRole: {
        findMany: vi.fn().mockResolvedValue([{ role: 'PARTNER' }, { role: 'EMPLOYEE' }]),
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await setRolesAction({ userId: USER_ID, roles: ['EMPLOYEE'] });

    expect(result).toEqual({
      ok: false,
      error: 'Die PARTNER-Rolle kann nur durch einen ADMIN entzogen werden.',
    });
    expect(tx.staffRole.deleteMany).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });
});
