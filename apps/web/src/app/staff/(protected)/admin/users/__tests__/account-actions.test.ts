import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const mocks = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    dbNull: Symbol('DbNull'),
    ActionError,
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    hash: vi.fn(),
    evidenceRecord: vi.fn(),
    revokeAllSessions: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('bcryptjs', () => ({ hash: mocks.hash }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({
  Prisma: { DbNull: mocks.dbNull },
  withTenantContext: mocks.withTenantContext,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rss/defaults', () => ({ seedDefaultRssFeeds: vi.fn() }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: mocks.revokeAllSessions }));
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

import { createUserAction, resetPasswordAction, resetTotpAction } from '../actions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: TENANT_ID,
    staffId: ADMIN_ID,
    ctx: { tenantId: TENANT_ID, actorId: ADMIN_ID, actorType: 'STAFF' },
  });
  mocks.hash.mockResolvedValue('new-password-hash');
  mocks.revokeAllSessions.mockResolvedValue(undefined);
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
        findUnique: vi.fn().mockResolvedValue({ id: USER_ID }),
        update: vi.fn().mockResolvedValue({ id: USER_ID }),
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
    expect(tx.staffUser.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { passwordHash: 'new-password-hash', failedLoginCount: 0, lockedUntil: null },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.password.reset',
        actorId: ADMIN_ID,
        resourceId: USER_ID,
        after: { changedBy: 'admin' },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('Neues-Passwort-2026!');
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('new-password-hash');
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', USER_ID);
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
});

describe('resetTotpAction', () => {
  it('löscht Secret, Enrollment und Backup-Codes atomar und widerruft Sitzungen', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          totpEnrolledAt: new Date('2026-08-21T12:00:00.000Z'),
          totpSecretEnc: 'encrypted-secret',
          totpSetupStartedAt: null,
          totpBackupCodes: ['hashed-backup-code'],
        }),
        update: vi.fn().mockResolvedValue({ id: USER_ID }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await resetTotpAction({ userId: USER_ID });

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        totpSecretEnc: null,
        totpEnrolledAt: null,
        totpSetupStartedAt: null,
        totpBackupCodes: mocks.dbNull,
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.totp.reset',
        before: { enrolled: true, setupPending: false },
        after: { enrolled: false, setupPending: false },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('encrypted-secret');
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', USER_ID);
  });

  it('verhindert den eigenen 2FA-Reset', async () => {
    const result = await resetTotpAction({ userId: ADMIN_ID });

    expect(result).toEqual({
      ok: false,
      error: 'Die eigene 2FA muss ein anderer Admin zurücksetzen.',
    });
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });
});
