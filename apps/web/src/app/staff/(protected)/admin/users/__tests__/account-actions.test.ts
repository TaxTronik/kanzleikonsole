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

import {
  createUserAction,
  resetPasswordAction,
  resetTotpAction,
  setActiveAction,
  setRolesAction,
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
      },
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
    expect(mocks.revokeAllSessions.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.staffUser.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it('bricht vor dem Passwort-Reset ab, wenn der Session-Widerruf fehlschlägt', async () => {
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

    expect(result).toEqual({
      ok: false,
      error: 'Session-Widerruf ist derzeit nicht verfügbar.',
    });
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
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
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', USER_ID);
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
      },
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
    expect(mocks.revokeAllSessions.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.staffUser.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it('bricht vor dem 2FA-Reset ab, wenn der Session-Widerruf fehlschlägt', async () => {
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

    expect(result).toEqual({
      ok: false,
      error: 'Session-Widerruf ist derzeit nicht verfügbar.',
    });
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
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
  });
});
