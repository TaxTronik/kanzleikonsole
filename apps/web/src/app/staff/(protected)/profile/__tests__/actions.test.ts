import { beforeEach, describe, expect, it, vi } from 'vitest';

const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => {
  class ActionError extends Error {}
  class HardwareAccessUnavailableError extends Error {}
  class HardwareAccessVerificationError extends Error {}
  return {
    ActionError,
    HardwareAccessUnavailableError,
    HardwareAccessVerificationError,
    staffActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    compare: vi.fn(),
    hash: vi.fn(),
    checkRateLimit: vi.fn(),
    evidenceRecord: vi.fn(),
    revokeAllSessions: vi.fn(),
    revalidatePath: vi.fn(),
    lockStaffHardwareAuthState: vi.fn(),
    lockMatchingHardwareMetadataSerial: vi.fn(),
    assertStoredHardwareCredentialTrusted: vi.fn(),
    beginHardwareModeAssertion: vi.fn(),
    beginHardwareRegistration: vi.fn(),
    consumeHardwareCeremony: vi.fn(),
    isAuthenticationResponse: vi.fn(),
    isRegistrationResponse: vi.fn(),
    verifyHardwareAssertion: vi.fn(),
    verifyHardwareRegistration: vi.fn(),
  };
});

vi.mock('bcryptjs', () => ({ compare: mocks.compare, hash: mocks.hash }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: mocks.revokeAllSessions }));
vi.mock('@/server/auth/staff-account-recovery-lock', () => ({
  lockStaffHardwareAuthState: mocks.lockStaffHardwareAuthState,
}));
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
vi.mock('@/server/auth/webauthn', () => ({
  HARDWARE_KEY_LIMIT: 10,
  HARDWARE_ONLY_MIN_KEYS: 2,
  HardwareAccessUnavailableError: mocks.HardwareAccessUnavailableError,
  HardwareAccessVerificationError: mocks.HardwareAccessVerificationError,
  assertStoredHardwareCredentialTrusted: mocks.assertStoredHardwareCredentialTrusted,
  beginHardwareModeAssertion: mocks.beginHardwareModeAssertion,
  beginHardwareRegistration: mocks.beginHardwareRegistration,
  consumeHardwareCeremony: mocks.consumeHardwareCeremony,
  isAuthenticationResponse: mocks.isAuthenticationResponse,
  isRegistrationResponse: mocks.isRegistrationResponse,
  lockMatchingHardwareMetadataSerial: mocks.lockMatchingHardwareMetadataSerial,
  verifyHardwareAssertion: mocks.verifyHardwareAssertion,
  verifyHardwareRegistration: mocks.verifyHardwareRegistration,
}));

import {
  beginHardwareKeyRegistrationAction,
  beginHardwareModeChangeAction,
  changeOwnPasswordAction,
  finishHardwareKeyRegistrationAction,
  finishHardwareModeChangeAction,
  removeHardwareKeyAction,
} from '../actions';

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
    session: { user: { authRevision: 7 } },
    ctx: { tenantId: TENANT_ID, actorId: STAFF_ID, actorType: 'STAFF' },
  });
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.hash.mockResolvedValue('new-password-hash');
  mocks.revokeAllSessions.mockResolvedValue(undefined);
  mocks.lockStaffHardwareAuthState.mockResolvedValue(undefined);
  mocks.lockMatchingHardwareMetadataSerial.mockResolvedValue(undefined);
  mocks.assertStoredHardwareCredentialTrusted.mockResolvedValue({
    transports: ['usb'],
    metadataSerial: 7n,
  });
  mocks.isAuthenticationResponse.mockReturnValue(true);
  mocks.isRegistrationResponse.mockReturnValue(true);
  mocks.verifyHardwareAssertion.mockResolvedValue({ newSignCount: 3n, metadataSerial: 7n });
  mocks.consumeHardwareCeremony.mockResolvedValue({ challenge: 'challenge' });
});

// Fachkatalog: ACCESS-TENANT-RLS-001
describe('Hardware-Schluesselregistrierung', () => {
  it('bindet die Registrierungs-Ceremony an die authentisierte Session-Revision', async () => {
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          email: 'staff@example.test',
          fullName: 'Staff Test',
          passwordHash: 'password-hash',
          hardwareOnlyEnabledAt: null,
          hardwareCredentials: [],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.compare.mockResolvedValueOnce(true);
    mocks.beginHardwareRegistration.mockResolvedValueOnce({
      ceremonyId: 'a'.repeat(32),
      options: { challenge: 'challenge' },
    });

    await expect(
      beginHardwareKeyRegistrationAction({
        label: 'USB-Schluessel',
        currentPassword: 'Aktuelles-Passwort!',
      }),
    ).resolves.toEqual({ ceremonyId: 'a'.repeat(32), options: { challenge: 'challenge' } });
    expect(tx.staffUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ authRevision: 7 }),
      }),
    );
    expect(mocks.beginHardwareRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ authRevision: 7 }),
    );
  });

  it('persistiert die serverseitig attestierte Authenticator-Version', async () => {
    const attestationVerifiedAt = new Date('2026-09-04T08:00:00.000Z');
    mocks.verifyHardwareRegistration.mockResolvedValue({
      credentialId: 'registered-credential-id',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0n,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationVerifiedAt,
      attestationFormat: 'packed',
      authenticatorVersion: 42n,
      metadataSerial: 7n,
      aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({ hardwareCredentials: [] }),
      },
      staffWebAuthnCredential: {
        create: vi.fn().mockResolvedValue({ id: 'credential-row-id' }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await finishHardwareKeyRegistrationAction({
      ceremonyId: 'a'.repeat(32),
      label: 'USB-Schluessel',
      response: { id: 'registered-credential-id' } as never,
    });

    expect(result).toEqual({ success: 'Sicherheitsschlüssel wurde hinzugefügt.' });
    expect(tx.staffWebAuthnCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        credentialId: 'registered-credential-id',
        authenticatorVersion: 42n,
        attestationVerifiedAt,
      }),
    });
    expect(mocks.lockStaffHardwareAuthState).toHaveBeenCalledWith(tx, TENANT_ID, STAFF_ID);
    expect(mocks.lockMatchingHardwareMetadataSerial).toHaveBeenCalledWith(tx, 7n);
    expect(mocks.consumeHardwareCeremony).toHaveBeenCalledWith({
      ceremonyId: 'a'.repeat(32),
      purpose: 'register',
      staffId: STAFF_ID,
      tenantId: TENANT_ID,
      authRevision: 7,
    });
    expect(tx.staffUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ authRevision: 7 }),
      }),
    );
    expect(mocks.lockStaffHardwareAuthState.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.staffUser.findFirst.mock.invocationCallOrder[0]!,
    );
  });

  it('legt nach einem parallelen Revision-Cutoff keinen bereits attestierten Schlüssel mehr an', async () => {
    mocks.verifyHardwareRegistration.mockResolvedValue({
      credentialId: 'registered-credential-id',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0n,
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationVerifiedAt: new Date('2026-09-04T08:00:00.000Z'),
      attestationFormat: 'packed',
      authenticatorVersion: 42n,
      metadataSerial: 7n,
      aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const tx = {
      staffUser: { findFirst: vi.fn().mockResolvedValue(null) },
      staffWebAuthnCredential: { create: vi.fn() },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    await expect(
      finishHardwareKeyRegistrationAction({
        ceremonyId: 'a'.repeat(32),
        label: 'USB-Schluessel',
        response: { id: 'registered-credential-id' } as never,
      }),
    ).resolves.toEqual({
      error: 'Das Konto wurde zwischenzeitlich geändert. Bitte neu laden.',
    });
    expect(tx.staffUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ authRevision: 7 }) }),
    );
    expect(tx.staffWebAuthnCredential.create).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});

// Fachkatalog: ACCESS-TENANT-RLS-001
describe('Hardware-Schlüsselwiderruf', () => {
  it('nimmt den gemeinsamen Kontolock vor dem Modus- und Credential-Read', async () => {
    const credentialId = '44444444-4444-4444-8444-444444444444';
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({ hardwareOnlyEnabledAt: null }),
      },
      staffWebAuthnCredential: {
        findFirst: vi.fn().mockResolvedValue({ id: credentialId, label: 'Tresor' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await removeHardwareKeyAction({ credentialId });

    expect(result).toEqual({ success: 'Sicherheitsschlüssel wurde entfernt.' });
    expect(mocks.lockStaffHardwareAuthState).toHaveBeenCalledWith(tx, TENANT_ID, STAFF_ID);
    expect(mocks.lockStaffHardwareAuthState.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.staffUser.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.staffUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ authRevision: 7 }) }),
    );
    expect(tx.staffWebAuthnCredential.updateMany).toHaveBeenCalledWith({
      where: { id: credentialId, tenantId: TENANT_ID, staffUserId: STAFF_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001
describe('Hardware-only-Moduswechsel', () => {
  it('bindet die Modus-Ceremony an die authentisierte Session-Revision', async () => {
    const key = {
      credentialId: 'credential-id-long-enough',
      transports: ['usb'],
    };
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          hardwareOnlyEnabledAt: null,
          totpEnrolledAt: new Date(),
          totpSecretEnc: 'encrypted-secret',
          hardwareCredentials: [key, { ...key, credentialId: 'second-credential-id' }],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.beginHardwareModeAssertion.mockResolvedValueOnce({
      ceremonyId: 'a'.repeat(32),
      options: { challenge: 'challenge' },
    });

    await expect(beginHardwareModeChangeAction({ enable: true })).resolves.toEqual({
      ceremonyId: 'a'.repeat(32),
      options: { challenge: 'challenge' },
    });
    expect(tx.staffUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ authRevision: 7 }) }),
    );
    expect(mocks.beginHardwareModeAssertion).toHaveBeenCalledWith(
      expect.objectContaining({ authRevision: 7 }),
    );
  });

  it('beginnt die Aktivierung erst mit mindestens zwei aktiven Schlüsseln', async () => {
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          hardwareOnlyEnabledAt: null,
          totpEnrolledAt: new Date(),
          totpSecretEnc: 'encrypted-secret',
          hardwareCredentials: [{ credentialId: 'key-1', transports: ['usb'] }],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await beginHardwareModeChangeAction({ enable: true });

    expect(result).toEqual({
      error: 'Hinterlegen Sie zuerst mindestens 2 physische Sicherheitsschlüssel.',
    });
    expect(mocks.beginHardwareModeAssertion).not.toHaveBeenCalled();
  });

  it('verhindert ein DEV-Opt-in ohne zuvor vollständig eingerichtetes TOTP', async () => {
    const key = { credentialId: 'key-1', transports: ['usb'] };
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          hardwareOnlyEnabledAt: null,
          totpEnrolledAt: null,
          totpSecretEnc: null,
          hardwareCredentials: [key, { ...key, credentialId: 'key-2' }],
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    await expect(beginHardwareModeChangeAction({ enable: true })).resolves.toEqual({
      error: 'Vor dem Hardware-Opt-in muss Passwort + 2FA vollständig eingerichtet sein.',
    });
    expect(mocks.beginHardwareModeAssertion).not.toHaveBeenCalled();
  });

  it('bindet die Aktivierung an eine frische Assertion, erhöht die Revision und widerruft Sessions', async () => {
    const key = {
      id: '44444444-4444-4444-8444-444444444444',
      credentialId: 'credential-id-long-enough',
      aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 2n,
      webauthnUserId: Buffer.from(STAFF_ID, 'utf8').toString('base64url'),
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date('2026-09-01T08:00:00.000Z'),
      authenticatorVersion: 42n,
    };
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          authRevision: 7,
          hardwareOnlyEnabledAt: null,
          totpEnrolledAt: new Date(),
          totpSecretEnc: 'encrypted-secret',
          hardwareCredentials: [key, { ...key, id: '55555555-5555-4555-8555-555555555555' }],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffWebAuthnCredential: {
        count: vi.fn().mockResolvedValue(2),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    const response = {
      id: key.credentialId,
      type: 'public-key',
      response: {},
    } as never;

    const result = await finishHardwareModeChangeAction({
      ceremonyId: 'a'.repeat(32),
      enable: true,
      response,
    });

    expect(result).toEqual({
      success: 'Nur-Sicherheitsschlüssel-Modus wurde aktiviert.',
      forceLogout: true,
    });
    expect(mocks.consumeHardwareCeremony).toHaveBeenCalledWith({
      ceremonyId: 'a'.repeat(32),
      purpose: 'mode-enable',
      staffId: STAFF_ID,
      tenantId: TENANT_ID,
      authRevision: 7,
    });
    expect(tx.staffUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ authRevision: 7 }) }),
    );
    expect(mocks.verifyHardwareAssertion).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF_ID,
        credential: expect.objectContaining({
          id: key.credentialId,
          authenticatorVersion: 42n,
        }),
      }),
    );
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.assertStoredHardwareCredentialTrusted).toHaveBeenCalledTimes(2);
    expect(mocks.lockMatchingHardwareMetadataSerial).toHaveBeenCalledWith(tx, 7n);
    expect(mocks.lockStaffHardwareAuthState).toHaveBeenCalledWith(tx, TENANT_ID, STAFF_ID);
    expect(tx.staffWebAuthnCredential.count).toHaveBeenCalledWith({
      where: {
        id: { in: [key.id, '55555555-5555-4555-8555-555555555555'] },
        tenantId: TENANT_ID,
        staffUserId: STAFF_ID,
        revokedAt: null,
      },
    });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith({
      where: {
        id: STAFF_ID,
        tenantId: TENANT_ID,
        active: true,
        authRevision: 7,
        hardwareOnlyEnabledAt: null,
      },
      data: {
        hardwareOnlyEnabledAt: expect.any(Date),
        authRevision: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'staff.hardware_only.enable',
        before: { mode: 'password_totp' },
        after: { mode: 'hardware_only' },
      }),
    );
    // Fachkatalog: ACCESS-TENANT-RLS-001 — authRevision ist der atomare
    // Session-Cutoff; ein später DB-Konflikt darf keinen Redis-Logout vorziehen.
  });

  it('verweigert das Opt-in, wenn nur einer von zwei aktiven Schlüsseln aktuell vertraut ist', async () => {
    const credentials = [
      { credentialId: 'key-1', transports: ['usb'] },
      { credentialId: 'key-2', transports: ['usb'] },
    ];
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          hardwareOnlyEnabledAt: null,
          totpEnrolledAt: new Date(),
          totpSecretEnc: 'encrypted-secret',
          hardwareCredentials: credentials,
        }),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    mocks.assertStoredHardwareCredentialTrusted
      .mockResolvedValueOnce(['usb'])
      .mockRejectedValueOnce(new mocks.HardwareAccessVerificationError());

    const result = await beginHardwareModeChangeAction({ enable: true });

    expect(result).toEqual({
      error: 'Mindestens 2 aktuell vertrauenswürdige Sicherheitsschlüssel sind erforderlich.',
    });
    expect(mocks.beginHardwareModeAssertion).not.toHaveBeenCalled();
  });

  it('bricht das Opt-in unter dem Kontolock ab, wenn ein zweiter geprüfter Schlüssel widerrufen wurde', async () => {
    const key = {
      id: '44444444-4444-4444-8444-444444444444',
      credentialId: 'credential-id-long-enough',
      aaguid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 2n,
      webauthnUserId: Buffer.from(STAFF_ID, 'utf8').toString('base64url'),
      transports: ['usb'],
      deviceType: 'singleDevice',
      backedUp: false,
      attestationFormat: 'packed',
      attestationVerifiedAt: new Date('2026-09-01T08:00:00.000Z'),
      authenticatorVersion: 42n,
    };
    const tx = {
      staffUser: {
        findFirst: vi.fn().mockResolvedValue({
          authRevision: 7,
          hardwareOnlyEnabledAt: null,
          totpEnrolledAt: new Date(),
          totpSecretEnc: 'encrypted-secret',
          hardwareCredentials: [key, { ...key, id: '55555555-5555-4555-8555-555555555555' }],
        }),
        updateMany: vi.fn(),
      },
      staffWebAuthnCredential: {
        count: vi.fn().mockResolvedValue(1),
        updateMany: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await finishHardwareModeChangeAction({
      ceremonyId: 'a'.repeat(32),
      enable: true,
      response: { id: key.credentialId, type: 'public-key', response: {} } as never,
    });

    expect(result).toEqual({
      error: 'Es sind nicht mehr genügend aktive Sicherheitsschlüssel vorhanden.',
    });
    expect(mocks.lockStaffHardwareAuthState).toHaveBeenCalledWith(tx, TENANT_ID, STAFF_ID);
    expect(tx.staffWebAuthnCredential.updateMany).not.toHaveBeenCalled();
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
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
        findUnique: vi
          .fn()
          .mockResolvedValue({ passwordHash: 'old-hash', active: true, authRevision: 7 }),
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
        findUnique: vi
          .fn()
          .mockResolvedValue({ passwordHash: 'old-hash', active: true, authRevision: 7 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffWebAuthnCredential: {
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
      where: {
        id: STAFF_ID,
        passwordHash: 'old-hash',
        active: true,
        authRevision: 7,
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
        action: 'staff.password.change',
        actorId: STAFF_ID,
        resourceId: STAFF_ID,
        after: { changedBy: 'self', revokedHardwareKeys: 1 },
      }),
    );
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('Neues-Passwort-2026!');
    expect(JSON.stringify(mocks.evidenceRecord.mock.calls)).not.toContain('new-password-hash');
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
    expect(mocks.lockStaffHardwareAuthState).toHaveBeenCalledWith(tx, TENANT_ID, STAFF_ID);
    expect(tx.staffWebAuthnCredential.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, staffUserId: STAFF_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('blockiert Passwortänderungen im Hardware-only-Modus vor bcrypt und Mutation', async () => {
    const tx = {
      staffUser: {
        findUnique: vi.fn().mockResolvedValue({
          passwordHash: 'dormant-password-hash',
          active: true,
          authRevision: 7,
          hardwareOnlyEnabledAt: new Date(),
        }),
        updateMany: vi.fn(),
      },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );

    const result = await changeOwnPasswordAction(null, passwordForm());

    expect(result).toEqual({
      ok: false,
      error: 'Im Modus „Nur Sicherheitsschlüssel“ ist das Passwort als Zugang deaktiviert.',
    });
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(tx.staffUser.updateMany).not.toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('überschreibt keine zwischenzeitliche Passwortänderung', async () => {
    const tx = {
      staffUser: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ passwordHash: 'old-hash', active: true, authRevision: 7 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      staffWebAuthnCredential: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('bindet die Passwortänderung unabhängig von Redis an die Auth-Revision', async () => {
    const tx = {
      staffUser: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ passwordHash: 'old-hash', active: true, authRevision: 7 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffWebAuthnCredential: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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

    expect(result).toEqual({ ok: true });
    expect(tx.staffUser.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authRevision: { increment: 1 } }),
      }),
    );
    expect(mocks.evidenceRecord).toHaveBeenCalled();
    expect(mocks.revokeAllSessions).not.toHaveBeenCalled();
  });
});
