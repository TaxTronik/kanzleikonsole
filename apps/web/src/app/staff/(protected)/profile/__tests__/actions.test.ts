import { beforeEach, describe, expect, it, vi } from 'vitest';

const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    compare: vi.fn(),
    hash: vi.fn(),
    checkRateLimit: vi.fn(),
    evidenceRecord: vi.fn(),
    revokeAllSessions: vi.fn(),
  };
});

vi.mock('bcryptjs', () => ({ compare: mocks.compare, hash: mocks.hash }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }));
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

import { changeOwnPasswordAction } from '../actions';

function passwordForm(current = 'Bisheriges-Passwort!', next = 'Neues-Passwort-2026!') {
  const formData = new FormData();
  formData.set('currentPassword', current);
  formData.set('newPassword', next);
  formData.set('confirmPassword', next);
  return formData;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: TENANT_ID,
    staffId: STAFF_ID,
    ctx: { tenantId: TENANT_ID, actorId: STAFF_ID, actorType: 'STAFF' },
  });
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.hash.mockResolvedValue('new-password-hash');
  mocks.revokeAllSessions.mockResolvedValue(undefined);
});

describe('changeOwnPasswordAction', () => {
  it('beendet unautorisierte Aufrufe vor Rate-Limit und bcrypt', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce({ ok: false, error: 'Nicht eingeloggt.' });

    const result = await changeOwnPasswordAction(null, passwordForm());

    expect(result).toEqual({ ok: false, error: 'Nicht eingeloggt.' });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('weist ein falsches aktuelles Passwort zurück und verändert nichts', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({ passwordHash: 'old-hash', active: true }),
        updateMany: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.compare.mockResolvedValueOnce(false);

    const result = await changeOwnPasswordAction(null, passwordForm('falsch'));

    expect(result).toEqual({ ok: false, error: 'Das aktuelle Passwort ist nicht korrekt.' });
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('ändert Passwort und Sperrzähler atomar, auditiert ohne Geheimnisse und widerruft Sessions', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({ passwordHash: 'old-hash', active: true }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await changeOwnPasswordAction(null, passwordForm());

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith({
      where: { id: STAFF_ID, passwordHash: 'old-hash', active: true },
      data: { passwordHash: 'new-password-hash', failedLoginCount: 0, lockedUntil: null },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.password.change',
        actorId: STAFF_ID,
        resourceId: STAFF_ID,
        after: { changedBy: 'self' },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('Neues-Passwort-2026!');
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('new-password-hash');
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', STAFF_ID);
    expect(mocks.revokeAllSessions.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.staffUser.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it('überschreibt keine zwischenzeitliche Passwortänderung', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({ passwordHash: 'old-hash', active: true }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await changeOwnPasswordAction(null, passwordForm());

    expect(result).toEqual({
      ok: false,
      error: 'Das Passwort wurde zwischenzeitlich geändert. Bitte melden Sie sich erneut an.',
    });
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', STAFF_ID);
  });

  it('bricht vor der Passwortänderung ab, wenn Redis den Widerruf nicht bestätigt', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({ passwordHash: 'old-hash', active: true }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.revokeAllSessions.mockRejectedValueOnce(
      new Error('Session-Widerruf ist derzeit nicht verfügbar.'),
    );

    const result = await changeOwnPasswordAction(null, passwordForm());

    expect(result).toEqual({
      ok: false,
      error: 'Session-Widerruf ist derzeit nicht verfügbar.',
    });
    expect(mocks.revokeAllSessions).toHaveBeenCalledWith('staff', STAFF_ID);
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});
