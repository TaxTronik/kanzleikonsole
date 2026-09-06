'use server';

import { compare, hash } from 'bcryptjs';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { evidenceService } from '@/server/container';
import { checkRateLimit } from '@/server/rate-limit';
import { toActionError } from '@/server/auth/rbac';
import { staffActionGuard, ActionError, type ActionResult } from '@/server/actions/staff-action';
import { validateStaffPasswordPair } from '@/lib/staff-password-policy';
import { lockStaffHardwareAuthState } from '@/server/auth/staff-account-recovery-lock';
import {
  assertStoredHardwareCredentialTrusted,
  beginHardwareModeAssertion,
  beginHardwareRegistration,
  consumeHardwareCeremony,
  HARDWARE_KEY_LIMIT,
  HARDWARE_ONLY_MIN_KEYS,
  HardwareAccessUnavailableError,
  HardwareAccessVerificationError,
  type HardwareCredentialTrustInput,
  isAuthenticationResponse,
  isRegistrationResponse,
  lockMatchingHardwareMetadataSerial,
  verifyHardwareAssertion,
  verifyHardwareRegistration,
} from '@/server/auth/webauthn';

const PASSWORD_CHANGE_LIMIT = { max: 5, windowSec: 15 * 60 };
const HARDWARE_SETUP_LIMIT = { max: 10, windowSec: 15 * 60 };
const PROFILE = '/staff/profile';

type HardwareMutationResult = { success: string; forceLogout?: boolean } | { error: string };

function hardwareError(error: unknown): { error: string } {
  if (
    error instanceof HardwareAccessUnavailableError ||
    error instanceof HardwareAccessVerificationError
  ) {
    return { error: error.message };
  }
  const mapped = toActionError(error);
  return { error: mapped.error };
}

async function currentlyTrustedHardwareCredentials<T extends HardwareCredentialTrustInput>(
  credentials: T[],
): Promise<{ credentials: T[]; metadataSerial: bigint | null }> {
  const trusted: T[] = [];
  let metadataSerial: bigint | null = null;
  for (const credential of credentials) {
    try {
      const trust = await assertStoredHardwareCredentialTrusted(credential);
      if (metadataSerial !== null && metadataSerial !== trust.metadataSerial) {
        throw new HardwareAccessUnavailableError(
          'Der FIDO-Vertrauensstand wurde aktualisiert. Bitte wiederholen Sie den Vorgang.',
        );
      }
      metadataSerial = trust.metadataSerial;
      trusted.push(credential);
    } catch (error) {
      if (!(error instanceof HardwareAccessVerificationError)) throw error;
    }
  }
  return { credentials: trusted, metadataSerial };
}

function assertFinishHardwareModeAccount<
  T extends {
    hardwareOnlyEnabledAt: Date | null;
    totpEnrolledAt: Date | null;
    totpSecretEnc: string | null;
  },
>(account: T | null, enable: boolean): asserts account is T {
  if (!account || Boolean(account.hardwareOnlyEnabledAt) === enable) {
    throw new ActionError('Das Konto wurde zwischenzeitlich geändert. Bitte neu laden.');
  }
  if (enable && (!account.totpEnrolledAt || !account.totpSecretEnc)) {
    throw new ActionError(
      'Vor dem Hardware-Opt-in muss Passwort + 2FA vollständig eingerichtet sein.',
    );
  }
  if (!enable && (!account.totpEnrolledAt || !account.totpSecretEnc)) {
    throw new ActionError('Passwort + 2FA ist nicht vollständig eingerichtet.');
  }
}

async function credentialsForFinishedHardwareModeChange<T extends HardwareCredentialTrustInput>(
  credentials: T[],
  enable: boolean,
): Promise<{ credentials: T[]; metadataSerial: bigint | null }> {
  if (!enable) return { credentials, metadataSerial: null };
  const eligibility = await currentlyTrustedHardwareCredentials(credentials);
  if (eligibility.credentials.length < HARDWARE_ONLY_MIN_KEYS) {
    throw new ActionError('Es sind nicht mehr genügend aktive Sicherheitsschlüssel vorhanden.');
  }
  return eligibility;
}

function assertHardwareMetadataUnchanged(
  enable: boolean,
  expectedSerial: bigint | null,
  verifiedSerial: bigint,
): void {
  if (enable && expectedSerial !== verifiedSerial) {
    throw new HardwareAccessUnavailableError(
      'Der FIDO-Vertrauensstand wurde aktualisiert. Bitte wiederholen Sie den Vorgang.',
    );
  }
}

export async function changeOwnPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx, session } = guard;
  const authRevision = session.user.authRevision ?? 0;

  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');
  const validationError = validateStaffPasswordPair(newPassword, confirmPassword);
  if (!currentPassword || validationError) {
    return { ok: false, error: validationError ?? 'Das aktuelle Passwort fehlt.' };
  }

  const limit = await checkRateLimit(`staff-password-change:${staffId}`, PASSWORD_CHANGE_LIMIT);
  if (!limit.ok) {
    return { ok: false, error: 'Zu viele Versuche. Bitte warten Sie einige Minuten.' };
  }

  try {
    const current = await withTenantContext(ctx, (tx) =>
      tx.staffUser.findUnique({
        where: { id: staffId },
        select: {
          passwordHash: true,
          active: true,
          hardwareOnlyEnabledAt: true,
          authRevision: true,
        },
      }),
    );
    if (!current?.active || current.authRevision !== authRevision) {
      throw new ActionError('Benutzerkonto nicht gefunden oder Sitzung nicht mehr aktuell.');
    }
    if (current.hardwareOnlyEnabledAt) {
      throw new ActionError(
        'Im Modus „Nur Sicherheitsschlüssel“ ist das Passwort als Zugang deaktiviert.',
      );
    }
    if (!(await compare(currentPassword, current.passwordHash))) {
      return { ok: false, error: 'Das aktuelle Passwort ist nicht korrekt.' };
    }
    if (await compare(newPassword, current.passwordHash)) {
      return { ok: false, error: 'Das neue Passwort muss sich vom aktuellen unterscheiden.' };
    }

    const passwordHash = await hash(newPassword, 12);
    await withTenantContext(ctx, async (tx) => {
      await lockStaffHardwareAuthState(tx, tenantId, staffId);
      const revokedHardwareKeys = await tx.staffWebAuthnCredential.updateMany({
        where: { tenantId, staffUserId: staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const updated = await tx.staffUser.updateMany({
        where: {
          id: staffId,
          passwordHash: current.passwordHash,
          active: true,
          authRevision,
          hardwareOnlyEnabledAt: null,
        },
        data: {
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          authRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ActionError(
          'Das Passwort wurde zwischenzeitlich geändert. Bitte melden Sie sich erneut an.',
        );
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.password.change',
        resourceType: 'staff_user',
        resourceId: staffId,
        after: { changedBy: 'self', revokedHardwareKeys: revokedHardwareKeys.count },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  // Die erhoehte Auth-Revision macht das aktuelle JWT beim naechsten
  // serverseitigen Sitzungsabgleich unmittelbar unbrauchbar. Der Client
  // entfernt danach ueber den hosttreuen Logout-Endpunkt alle Cookies.
  return { ok: true };
}

const RegistrationStartSchema = z.object({
  label: z.string().trim().min(2, 'Bitte einen Schlüsselnamen angeben.').max(80),
  currentPassword: z.string().min(1).max(4096),
});

export type BeginHardwareRegistrationResult =
  | { ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }
  | { error: string };

export async function beginHardwareKeyRegistrationAction(input: {
  label: string;
  currentPassword: string;
}): Promise<BeginHardwareRegistrationResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return { error: guard.error };
  const parsed = RegistrationStartSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.' };
  }
  const { tenantId, staffId, ctx, session } = guard;
  const authRevision = session.user.authRevision ?? 0;
  const limit = await checkRateLimit(`staff-hardware-setup:${staffId}`, HARDWARE_SETUP_LIMIT);
  if (!limit.ok) return { error: 'Zu viele Schlüssel-Anfragen. Bitte kurz warten.' };

  try {
    const account = await withTenantContext(ctx, (tx) =>
      tx.staffUser.findFirst({
        where: { id: staffId, tenantId, active: true, authRevision },
        select: {
          email: true,
          fullName: true,
          passwordHash: true,
          hardwareOnlyEnabledAt: true,
          hardwareCredentials: {
            where: { revokedAt: null },
            select: { credentialId: true, transports: true },
          },
        },
      }),
    );
    if (!account) throw new ActionError('Benutzerkonto nicht gefunden oder deaktiviert.');
    if (account.hardwareOnlyEnabledAt) {
      throw new ActionError(
        'Während „Nur Sicherheitsschlüssel“ aktiv ist, ist die Schlüsselliste gesperrt. Deaktivieren Sie den Modus zuerst.',
      );
    }
    if (account.hardwareCredentials.length >= HARDWARE_KEY_LIMIT) {
      throw new ActionError(
        `Es können höchstens ${HARDWARE_KEY_LIMIT} Schlüssel hinterlegt werden.`,
      );
    }
    if (!(await compare(parsed.data.currentPassword, account.passwordHash))) {
      return { error: 'Das aktuelle Passwort ist nicht korrekt.' };
    }
    return await beginHardwareRegistration({
      staffId,
      tenantId,
      authRevision,
      email: account.email,
      fullName: account.fullName,
      existingCredentials: account.hardwareCredentials,
    });
  } catch (error) {
    return hardwareError(error);
  }
}

export async function finishHardwareKeyRegistrationAction(input: {
  ceremonyId: string;
  label: string;
  response: RegistrationResponseJSON;
}): Promise<HardwareMutationResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return { error: guard.error };
  const label = z.string().trim().min(2).max(80).safeParse(input?.label);
  if (
    !label.success ||
    typeof input?.ceremonyId !== 'string' ||
    input.ceremonyId.length > 128 ||
    !isRegistrationResponse(input.response)
  ) {
    return { error: 'Die Schlüsseldaten sind ungültig.' };
  }
  const { tenantId, staffId, ctx, session } = guard;
  const authRevision = session.user.authRevision ?? 0;
  try {
    const ceremony = await consumeHardwareCeremony({
      ceremonyId: input.ceremonyId,
      purpose: 'register',
      staffId,
      tenantId,
      authRevision,
    });
    const verified = await verifyHardwareRegistration({ response: input.response, ceremony });
    await withTenantContext(ctx, async (tx) => {
      await lockMatchingHardwareMetadataSerial(tx, verified.metadataSerial);
      // Derselbe Lock serialisiert Moduswechsel, Registrierung und Widerruf.
      // Der nachfolgende Modus-/Bestandsread ist damit der entscheidende
      // frische Snapshot und schützt zugleich das Credential-Limit.
      await lockStaffHardwareAuthState(tx, tenantId, staffId);
      const account = await tx.staffUser.findFirst({
        where: {
          id: staffId,
          tenantId,
          active: true,
          authRevision,
          hardwareOnlyEnabledAt: null,
        },
        select: {
          hardwareCredentials: {
            where: { revokedAt: null },
            select: { id: true },
          },
        },
      });
      if (!account) {
        throw new ActionError('Das Konto wurde zwischenzeitlich geändert. Bitte neu laden.');
      }
      if (account.hardwareCredentials.length >= HARDWARE_KEY_LIMIT) {
        throw new ActionError(
          `Es können höchstens ${HARDWARE_KEY_LIMIT} Schlüssel hinterlegt werden.`,
        );
      }
      const created = await tx.staffWebAuthnCredential.create({
        data: {
          tenantId,
          staffUserId: staffId,
          credentialId: verified.credentialId,
          publicKey: new Uint8Array(verified.publicKey),
          signCount: verified.signCount,
          webauthnUserId: Buffer.from(staffId, 'utf8').toString('base64url'),
          transports: verified.transports,
          deviceType: verified.deviceType,
          backedUp: verified.backedUp,
          attestationVerifiedAt: verified.attestationVerifiedAt,
          attestationFormat: verified.attestationFormat,
          authenticatorVersion: verified.authenticatorVersion,
          aaguid: verified.aaguid,
          label: label.data,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.security_key.register',
        resourceType: 'staff_webauthn_credential',
        resourceId: created.id,
        after: { label: label.data, deviceType: verified.deviceType },
      });
    });
    revalidatePath(PROFILE);
    return { success: 'Sicherheitsschlüssel wurde hinzugefügt.' };
  } catch (error) {
    return hardwareError(error);
  }
}

export async function removeHardwareKeyAction(input: {
  credentialId: string;
}): Promise<HardwareMutationResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return { error: guard.error };
  const parsed = z.object({ credentialId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: 'Ungültiger Sicherheitsschlüssel.' };
  const { tenantId, staffId, ctx, session } = guard;
  const authRevision = session.user.authRevision ?? 0;
  try {
    await withTenantContext(ctx, async (tx) => {
      await lockStaffHardwareAuthState(tx, tenantId, staffId);
      const account = await tx.staffUser.findFirst({
        where: { id: staffId, tenantId, active: true, authRevision },
        select: { hardwareOnlyEnabledAt: true },
      });
      if (!account) throw new ActionError('Benutzerkonto nicht gefunden.');
      if (account.hardwareOnlyEnabledAt) {
        throw new ActionError(
          'Im Hardware-Modus können Schlüssel erst nach dessen Deaktivierung entfernt werden.',
        );
      }
      const key = await tx.staffWebAuthnCredential.findFirst({
        where: {
          id: parsed.data.credentialId,
          tenantId,
          staffUserId: staffId,
          revokedAt: null,
        },
        select: { id: true, label: true },
      });
      if (!key) throw new ActionError('Sicherheitsschlüssel nicht gefunden.');
      const revoked = await tx.staffWebAuthnCredential.updateMany({
        where: { id: key.id, tenantId, staffUserId: staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) {
        throw new ActionError('Der Sicherheitsschlüssel wurde parallel geändert.');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.security_key.remove',
        resourceType: 'staff_webauthn_credential',
        resourceId: key.id,
        before: { label: key.label, active: true },
        after: { label: key.label, active: false },
      });
    });
    revalidatePath(PROFILE);
    return { success: 'Sicherheitsschlüssel wurde entfernt.' };
  } catch (error) {
    return hardwareError(error);
  }
}

export type BeginHardwareModeChangeResult =
  | { ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { error: string };

export async function beginHardwareModeChangeAction(input: {
  enable: boolean;
}): Promise<BeginHardwareModeChangeResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return { error: guard.error };
  const parsed = z.object({ enable: z.boolean() }).safeParse(input);
  if (!parsed.success) return { error: 'Ungültiger Moduswechsel.' };
  const { tenantId, staffId, ctx, session } = guard;
  const authRevision = session.user.authRevision ?? 0;
  const limit = await checkRateLimit(`staff-hardware-mode:${staffId}`, HARDWARE_SETUP_LIMIT);
  if (!limit.ok) return { error: 'Zu viele Moduswechsel. Bitte kurz warten.' };
  try {
    const account = await withTenantContext(ctx, (tx) =>
      tx.staffUser.findFirst({
        where: { id: staffId, tenantId, active: true, authRevision },
        select: {
          hardwareOnlyEnabledAt: true,
          totpEnrolledAt: true,
          totpSecretEnc: true,
          hardwareCredentials: {
            where: { revokedAt: null },
            select: {
              id: true,
              credentialId: true,
              aaguid: true,
              publicKey: true,
              signCount: true,
              webauthnUserId: true,
              transports: true,
              deviceType: true,
              backedUp: true,
              attestationFormat: true,
              attestationVerifiedAt: true,
              authenticatorVersion: true,
            },
          },
        },
      }),
    );
    if (!account) throw new ActionError('Benutzerkonto nicht gefunden.');
    const enabled = Boolean(account.hardwareOnlyEnabledAt);
    if (enabled === parsed.data.enable) {
      throw new ActionError('Der gewählte Anmeldemodus ist bereits aktiv.');
    }
    if (parsed.data.enable && (!account.totpEnrolledAt || !account.totpSecretEnc)) {
      throw new ActionError(
        'Vor dem Hardware-Opt-in muss Passwort + 2FA vollständig eingerichtet sein.',
      );
    }
    if (parsed.data.enable && account.hardwareCredentials.length < HARDWARE_ONLY_MIN_KEYS) {
      throw new ActionError(
        `Hinterlegen Sie zuerst mindestens ${HARDWARE_ONLY_MIN_KEYS} physische Sicherheitsschlüssel.`,
      );
    }
    if (!parsed.data.enable && (!account.totpEnrolledAt || !account.totpSecretEnc)) {
      throw new ActionError(
        'Passwort + 2FA kann nicht reaktiviert werden, weil keine vollständige TOTP-Einrichtung vorhanden ist. Bitte Admin kontaktieren.',
      );
    }
    const eligibility = parsed.data.enable
      ? await currentlyTrustedHardwareCredentials(account.hardwareCredentials)
      : { credentials: account.hardwareCredentials, metadataSerial: null };
    const eligibleCredentials = eligibility.credentials;
    if (parsed.data.enable && eligibleCredentials.length < HARDWARE_ONLY_MIN_KEYS) {
      throw new ActionError(
        `Mindestens ${HARDWARE_ONLY_MIN_KEYS} aktuell vertrauenswürdige Sicherheitsschlüssel sind erforderlich.`,
      );
    }
    return await beginHardwareModeAssertion({
      purpose: parsed.data.enable ? 'mode-enable' : 'mode-disable',
      staffId,
      tenantId,
      authRevision,
      credentials: eligibleCredentials,
    });
  } catch (error) {
    return hardwareError(error);
  }
}

export async function finishHardwareModeChangeAction(input: {
  ceremonyId: string;
  enable: boolean;
  response: AuthenticationResponseJSON;
}): Promise<HardwareMutationResult> {
  const guard = await staffActionGuard();
  if (!guard.ok) return { error: guard.error };
  const parsed = z
    .object({ ceremonyId: z.string().max(128), enable: z.boolean() })
    .safeParse({ ceremonyId: input?.ceremonyId, enable: input?.enable });
  if (!parsed.success || !isAuthenticationResponse(input.response)) {
    return { error: 'Die Antwort des Sicherheitsschlüssels ist ungültig.' };
  }
  const { tenantId, staffId, ctx, session } = guard;
  const authRevision = session.user.authRevision ?? 0;
  const purpose = parsed.data.enable ? 'mode-enable' : 'mode-disable';
  try {
    const ceremony = await consumeHardwareCeremony({
      ceremonyId: parsed.data.ceremonyId,
      purpose,
      staffId,
      tenantId,
      authRevision,
    });
    const account = await withTenantContext(ctx, (tx) =>
      tx.staffUser.findFirst({
        where: { id: staffId, tenantId, active: true, authRevision },
        select: {
          authRevision: true,
          hardwareOnlyEnabledAt: true,
          totpEnrolledAt: true,
          totpSecretEnc: true,
          hardwareCredentials: {
            where: { revokedAt: null },
            select: {
              id: true,
              credentialId: true,
              aaguid: true,
              publicKey: true,
              signCount: true,
              webauthnUserId: true,
              transports: true,
              deviceType: true,
              backedUp: true,
              attestationFormat: true,
              attestationVerifiedAt: true,
              authenticatorVersion: true,
            },
          },
        },
      }),
    );
    assertFinishHardwareModeAccount(account, parsed.data.enable);
    const eligibility = await credentialsForFinishedHardwareModeChange(
      account.hardwareCredentials,
      parsed.data.enable,
    );
    const eligibleCredentials = eligibility.credentials;
    const key = eligibleCredentials.find(
      (credential) => credential.credentialId === input.response.id,
    );
    if (!key?.aaguid) throw new HardwareAccessVerificationError();
    const assertion = await verifyHardwareAssertion({
      response: input.response,
      ceremony,
      credential: {
        id: key.credentialId,
        aaguid: key.aaguid,
        publicKey: key.publicKey,
        signCount: key.signCount,
        webauthnUserId: key.webauthnUserId,
        transports: key.transports,
        deviceType: key.deviceType,
        backedUp: key.backedUp,
        attestationFormat: key.attestationFormat,
        attestationVerifiedAt: key.attestationVerifiedAt,
        authenticatorVersion: key.authenticatorVersion,
      },
      staffId,
    });
    assertHardwareMetadataUnchanged(
      parsed.data.enable,
      eligibility.metadataSerial,
      assertion.metadataSerial,
    );

    await withTenantContext(ctx, async (tx) => {
      await lockMatchingHardwareMetadataSerial(tx, assertion.metadataSerial);
      await lockStaffHardwareAuthState(tx, tenantId, staffId);
      if (parsed.data.enable) {
        const stillActive = await tx.staffWebAuthnCredential.count({
          where: {
            id: { in: eligibleCredentials.map((credential) => credential.id) },
            tenantId,
            staffUserId: staffId,
            revokedAt: null,
          },
        });
        if (stillActive < HARDWARE_ONLY_MIN_KEYS) {
          throw new ActionError(
            'Es sind nicht mehr genügend aktive Sicherheitsschlüssel vorhanden.',
          );
        }
      }
      const keyUpdated = await tx.staffWebAuthnCredential.updateMany({
        where: {
          id: key.id,
          tenantId,
          staffUserId: staffId,
          revokedAt: null,
          signCount: key.signCount,
        },
        data: { signCount: assertion.newSignCount, lastUsedAt: new Date() },
      });
      if (keyUpdated.count !== 1) {
        throw new ActionError('Der Sicherheitsschlüssel wurde parallel verwendet.');
      }
      const changed = await tx.staffUser.updateMany({
        where: {
          id: staffId,
          tenantId,
          active: true,
          authRevision,
          hardwareOnlyEnabledAt: parsed.data.enable ? null : { not: null },
        },
        data: {
          hardwareOnlyEnabledAt: parsed.data.enable ? new Date() : null,
          // Die Revision ist der transaktionale Session-Cutoff. Dadurch gibt
          // es vor Lock, CAS und Audit keinen irreversiblen Redis-Seiteneffekt.
          authRevision: { increment: 1 },
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      if (changed.count !== 1) {
        throw new ActionError('Der Anmeldemodus wurde parallel geändert.');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: parsed.data.enable ? 'staff.hardware_only.enable' : 'staff.hardware_only.disable',
        resourceType: 'staff_user',
        resourceId: staffId,
        before: { mode: parsed.data.enable ? 'password_totp' : 'hardware_only' },
        after: { mode: parsed.data.enable ? 'hardware_only' : 'password_totp' },
      });
    });
    revalidatePath(PROFILE);
    return {
      success: parsed.data.enable
        ? 'Nur-Sicherheitsschlüssel-Modus wurde aktiviert.'
        : 'Passwort + 2FA wurde wieder aktiviert.',
      forceLogout: true,
    };
  } catch (error) {
    return hardwareError(error);
  }
}
