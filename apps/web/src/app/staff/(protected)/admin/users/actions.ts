'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { compare, hash } from 'bcryptjs';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { env } from '@taxtronik/config';
import { revokeAllSessions } from '@/server/auth/revocation';
import { Prisma, withTenantContext, type TenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { seedDefaultRssFeeds } from '@/server/rss/defaults';
import { toActionError } from '@/server/auth/rbac';
import { STAFF_PERMISSION_VALUES } from '@/lib/staff-permissions';
import { validateStaffPasswordPair } from '@/lib/staff-password-policy';
import { staffActionGuard, ActionError, type ActionResult } from '@/server/actions/staff-action';
import {
  lockStaffAccountRecovery,
  revokeStaffHardwareCredentialsForRecovery,
  revokeStaffHardwareCredentialsForSecurityReset,
} from '@/server/auth/staff-account-recovery-lock';
import { decryptTotpSecret, verifyTotpCode } from '@/server/auth/totp';
import { consumeTotpCode } from '@/server/auth/totp-replay';
import { checkRateLimit } from '@/server/rate-limit';
import {
  beginHardwareModeAssertion,
  consumeHardwareCeremony,
  HardwareAccessUnavailableError,
  HardwareAccessVerificationError,
  isAuthenticationResponse,
  lockMatchingHardwareMetadataSerial,
  verifyHardwareAssertion,
} from '@/server/auth/webauthn';

const LIST = '/staff/admin/users';
const ROLE_VALUES = ['EMPLOYEE', 'PARTNER', 'ADMIN'] as const;
type StaffRole = (typeof ROLE_VALUES)[number];

const ADMIN_RECOVERY_CLI_ONLY =
  'ADMIN-Konten können nur über die Administrations-CLI zurückgesetzt werden.';
const PARTNER_RECOVERY_ADMIN_ONLY =
  'PARTNER-Konten können nur durch einen ADMIN zurückgesetzt werden.';
const RECOVERY_STEP_UP_FAILED =
  'Die zusätzliche Identitätsbestätigung ist ungültig oder abgelaufen.';
const RECOVERY_STEP_UP_LIMIT = { max: 5, windowSec: 15 * 60 };
const RECOVERY_STEP_UP_BEGIN_LIMIT = { max: 10, windowSec: 15 * 60 };

function isActualAdmin(roles: readonly string[]): boolean {
  return roles.includes('ADMIN');
}

function roleNames(user: { roles: Array<{ role: StaffRole }> }): StaffRole[] {
  return user.roles.map((entry) => entry.role);
}

/**
 * Kontozugänge folgen einer strengeren Hierarchie als der übrige
 * ADMIN/PARTNER-Bereich:
 *   - ADMIN-Zugänge und deren 2FA sind ausschließlich per Operator-CLI recoverbar.
 *   - PARTNER-Zugänge darf nur ein echter ADMIN zurücksetzen.
 *   - EMPLOYEE-Zugänge dürfen ADMIN und PARTNER zurücksetzen.
 *
 * Diese Prüfung muss serverseitig unmittelbar auf den frisch gelesenen
 * Zielrollen laufen; die ausgeblendeten UI-Buttons sind nur Bedienkomfort.
 */
function assertAccountRecoveryAllowed(
  actorRoles: readonly string[],
  targetRoles: readonly StaffRole[],
): void {
  if (targetRoles.includes('ADMIN')) throw new ActionError(ADMIN_RECOVERY_CLI_ONLY);
  if (targetRoles.includes('PARTNER') && !isActualAdmin(actorRoles)) {
    throw new ActionError(PARTNER_RECOVERY_ADMIN_ONLY);
  }
}

function assertPartnerCannotManageAdmin(
  actorRoles: readonly string[],
  targetRoles: readonly StaffRole[],
): void {
  if (!isActualAdmin(actorRoles) && targetRoles.includes('ADMIN')) {
    throw new ActionError('ADMIN-Konten können nur durch einen ADMIN verwaltet werden.');
  }
}

function accountRecoveryProtectedRoles(actorRoles: readonly string[]): StaffRole[] {
  return isActualAdmin(actorRoles) ? ['ADMIN'] : ['ADMIN', 'PARTNER'];
}

// ----------------------------------------------------------------------------
// Anlegen
// ----------------------------------------------------------------------------

const CreateSchema = z
  .object({
    fullName: z.string().min(2).max(200),
    email: z.string().email().max(255),
    password: z.string(),
    confirmPassword: z.string(),
    partner: z.boolean(),
    admin: z.boolean(),
    isProfessional: z.boolean(),
    datevAdvisorNumber: z.string().trim().max(40),
  })
  .superRefine((data, ctx) => {
    const error = validateStaffPasswordPair(data.password, data.confirmPassword);
    if (error) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: error });
  });

export async function createUserAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // Gate ZUERST — vor dem teuren bcrypt-Hash (kein unautorisiertes Hashing).
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = CreateSchema.safeParse({
    fullName: formData.get('fullName'),
    email: formData.get('email'),
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
    partner: formData.get('role.PARTNER') === 'on',
    admin: formData.get('role.ADMIN') === 'on',
    isProfessional: formData.get('isProfessional') === 'on',
    datevAdvisorNumber: String(formData.get('datevAdvisorNumber') ?? ''),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  if (parsed.data.admin && !isActualAdmin(g.session.user.roles)) {
    return { ok: false, error: 'Die ADMIN-Rolle kann nur durch einen ADMIN vergeben werden.' };
  }

  const passwordHash = await hash(parsed.data.password, 12);

  const roles: StaffRole[] = ['EMPLOYEE'];
  if (parsed.data.partner) roles.push('PARTNER');
  if (parsed.data.admin) roles.push('ADMIN');

  try {
    await withTenantContext(ctx, async (tx) => {
      const existing = await tx.staffUser.findFirst({
        where: { email: parsed.data.email },
        select: { id: true },
      });
      if (existing) throw new ActionError('E-Mail bereits vergeben.');

      const created = await tx.staffUser.create({
        data: {
          tenantId,
          email: parsed.data.email,
          fullName: parsed.data.fullName,
          passwordHash,
          active: true,
          isProfessional: parsed.data.isProfessional,
          datevAdvisorNumber: parsed.data.datevAdvisorNumber || null,
          professionalQualificationSource: 'manual',
          roles: { create: roles.map((r) => ({ role: r })) },
        },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.create',
        resourceType: 'staff_user',
        resourceId: created.id,
        after: {
          fullName: parsed.data.fullName,
          email: parsed.data.email,
          roles,
          isProfessional: parsed.data.isProfessional,
          datevAdvisorNumber: parsed.data.datevAdvisorNumber || null,
          professionalQualificationSource: 'manual',
        },
      });

      await seedDefaultRssFeeds(tx, tenantId, created.id);
    });
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath(LIST);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Kontozugang zurücksetzen
// ----------------------------------------------------------------------------

export async function setProfessionalProfileAction(input: {
  userId: string;
  isProfessional: boolean;
  datevAdvisorNumber: string;
}): Promise<ActionResult & { assignmentGaps?: Array<{ id: string; name: string }> }> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx, session } = guard;
  const parsed = z
    .object({
      userId: z.string().uuid(),
      isProfessional: z.boolean(),
      datevAdvisorNumber: z.string().trim().max(40),
    })
    .safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: 'Beraternummer: maximal 40 Zeichen; Benutzer und Qualifikation prüfen.',
    };
  try {
    const assignmentGaps = await withTenantContext(ctx, async (tx) => {
      const before = await tx.staffUser.findFirst({
        where: { id: parsed.data.userId, tenantId },
        select: {
          isProfessional: true,
          datevAdvisorNumber: true,
          professionalQualificationSource: true,
          roles: { select: { role: true } },
        },
      });
      if (!before) throw new ActionError('Benutzer nicht gefunden.');
      assertPartnerCannotManageAdmin(session.user.roles, roleNames(before));
      const after = {
        isProfessional: parsed.data.isProfessional,
        datevAdvisorNumber: parsed.data.datevAdvisorNumber || null,
        professionalQualificationSource: 'manual',
      };
      if (before.isProfessional && !after.isProfessional)
        await revokeAllSessions('staff', parsed.data.userId);
      const updated = await tx.staffUser.updateMany({
        where: {
          id: parsed.data.userId,
          tenantId,
          isProfessional: before.isProfessional,
          datevAdvisorNumber: before.datevAdvisorNumber,
          professionalQualificationSource: before.professionalQualificationSource,
          ...(!isActualAdmin(session.user.roles)
            ? { roles: { none: { role: 'ADMIN' as const } } }
            : {}),
        },
        data: after,
      });
      if (updated.count !== 1)
        throw new ActionError('Benutzer wurde parallel geändert. Bitte neu laden.');
      const changed =
        before.isProfessional !== after.isProfessional ||
        before.datevAdvisorNumber !== after.datevAdvisorNumber ||
        before.professionalQualificationSource !== 'manual';
      if (changed)
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'staff.professional_profile.update',
          resourceType: 'staff_user',
          resourceId: parsed.data.userId,
          before: {
            isProfessional: before.isProfessional,
            datevAdvisorNumber: before.datevAdvisorNumber,
            professionalQualificationSource: before.professionalQualificationSource,
          },
          after,
        });
      if (after.isProfessional) return [];
      return tx.client.findMany({
        where: {
          tenantId,
          AND: [
            { responsibilities: { some: { staffId: parsed.data.userId, role: 'BERUFSTRAEGER' } } },
            {
              responsibilities: {
                none: {
                  role: 'BERUFSTRAEGER',
                  staff: { active: true, isProfessional: true, roles: { some: {} } },
                },
              },
            },
          ],
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
    });
    revalidatePath(LIST);
    revalidatePath('/staff/clients/new');
    revalidatePath('/staff/clients/onboarding/new');
    for (const client of assignmentGaps) revalidatePath(`/staff/clients/${client.id}/gwg`);
    return { ok: true, assignmentGaps };
  } catch (error) {
    return toActionError(error);
  }
}

export async function resetPasswordAction(input: {
  userId: string;
  password: string;
  confirmPassword: string;
}): Promise<ActionResult> {
  // Gate vor bcrypt: nicht autorisierte Requests dürfen keine teure Arbeit auslösen.
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx, session } = guard;
  const actorAuthRevision = session.user.authRevision ?? 0;

  const parsed = z
    .object({
      userId: z.string().uuid(),
      password: z.string(),
      confirmPassword: z.string(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const validationError = validateStaffPasswordPair(
    parsed.data.password,
    parsed.data.confirmPassword,
  );
  if (validationError) return { ok: false, error: validationError };
  if (parsed.data.userId === staffId) {
    return { ok: false, error: 'Das eigene Passwort bitte im Benutzerprofil ändern.' };
  }

  try {
    const target = await withTenantContext(ctx, (tx) =>
      tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: {
          id: true,
          hardwareOnlyEnabledAt: true,
          roles: { select: { role: true } },
        },
      }),
    );
    if (!target) throw new ActionError('Benutzer nicht gefunden.');
    assertAccountRecoveryAllowed(session.user.roles, roleNames(target));
    if (target.hardwareOnlyEnabledAt) {
      throw new ActionError(
        'Für dieses Konto ist „Nur Sicherheitsschlüssel“ aktiv. Verwenden Sie „Hardware-Zugang wiederherstellen“.',
      );
    }

    const passwordHash = await hash(parsed.data.password, 12);
    await withTenantContext(ctx, async (tx) => {
      const revokedHardwareKeys = await revokeStaffHardwareCredentialsForSecurityReset(
        tx,
        parsed.data.userId,
        actorAuthRevision,
      );
      const lockedTarget = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: {
          hardwareOnlyEnabledAt: true,
          roles: { select: { role: true } },
        },
      });
      if (!lockedTarget) throw new ActionError('Benutzer nicht gefunden.');
      assertAccountRecoveryAllowed(session.user.roles, roleNames(lockedTarget));
      if (lockedTarget.hardwareOnlyEnabledAt) {
        throw new ActionError(
          'Für dieses Konto ist „Nur Sicherheitsschlüssel“ aktiv. Verwenden Sie „Hardware-Zugang wiederherstellen“.',
        );
      }
      // Der DB-Advisory-Lock serialisiert dies mit staff_role-Mutationen; der
      // Rollenfilter im Update bleibt zusaetzliche Defense in Depth.
      const updated = await tx.staffUser.updateMany({
        where: {
          id: parsed.data.userId,
          roles: {
            none: { role: { in: accountRecoveryProtectedRoles(session.user.roles) } },
          },
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
        throw new ActionError('Kontorollen wurden parallel geändert; Reset abgebrochen.');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.password.reset',
        resourceType: 'staff_user',
        resourceId: parsed.data.userId,
        after: { changedBy: 'admin', revokedHardwareKeys },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  revalidatePath(LIST);
  return { ok: true };
}

export async function resetTotpAction(input: { userId: string }): Promise<ActionResult> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx, session } = guard;
  const actorAuthRevision = session.user.authRevision ?? 0;

  const parsed = z.object({ userId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.userId === staffId) {
    return {
      ok: false,
      error: isActualAdmin(session.user.roles)
        ? ADMIN_RECOVERY_CLI_ONLY
        : 'Die eigene 2FA muss eine übergeordnete Rolle zurücksetzen.',
    };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      const revokedHardwareKeys = await revokeStaffHardwareCredentialsForSecurityReset(
        tx,
        parsed.data.userId,
        actorAuthRevision,
      );
      const before = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: {
          roles: { select: { role: true } },
          totpEnrolledAt: true,
          totpSecretEnc: true,
          totpSetupStartedAt: true,
          totpBackupCodes: true,
          hardwareOnlyEnabledAt: true,
        },
      });
      if (!before) throw new ActionError('Benutzer nicht gefunden.');
      assertAccountRecoveryAllowed(session.user.roles, roleNames(before));
      if (before.hardwareOnlyEnabledAt) {
        throw new ActionError(
          'Für dieses Konto ist „Nur Sicherheitsschlüssel“ aktiv. Verwenden Sie „Hardware-Zugang wiederherstellen“.',
        );
      }
      const hasBackupCodes = Array.isArray(before.totpBackupCodes)
        ? before.totpBackupCodes.length > 0
        : Boolean(before.totpBackupCodes);
      if (
        !before.totpEnrolledAt &&
        !before.totpSecretEnc &&
        !before.totpSetupStartedAt &&
        !hasBackupCodes
      ) {
        throw new ActionError('Für diesen Benutzer ist keine 2FA eingerichtet.');
      }

      const updated = await tx.staffUser.updateMany({
        where: {
          id: parsed.data.userId,
          roles: {
            none: { role: { in: accountRecoveryProtectedRoles(session.user.roles) } },
          },
          hardwareOnlyEnabledAt: null,
        },
        data: {
          totpSecretEnc: null,
          totpEnrolledAt: null,
          totpSetupStartedAt: null,
          totpBackupCodes: Prisma.DbNull,
          authRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ActionError('Kontorollen wurden parallel geändert; Reset abgebrochen.');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.totp.reset',
        resourceType: 'staff_user',
        resourceId: parsed.data.userId,
        before: {
          enrolled: Boolean(before.totpEnrolledAt),
          setupPending:
            Boolean(before.totpSecretEnc || before.totpSetupStartedAt) && !before.totpEnrolledAt,
        },
        after: { enrolled: false, setupPending: false, revokedHardwareKeys },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  revalidatePath(LIST);
  return { ok: true };
}

/**
 * Expliziter Break-glass-Pfad für den Verlust aller physischen Schlüssel.
 * Er deaktiviert Hardware-only, sperrt sämtliche registrierten Schlüssel,
 * setzt ein neues Passwort und erzwingt beim nächsten Login ein neues TOTP-
 * Enrollment. Die bestehende ADMIN/PARTNER-Hierarchie bleibt unverändert.
 */
export type BeginHardwareRecoveryStepUpResult =
  | {
      ceremonyId: string;
      options: PublicKeyCredentialRequestOptionsJSON;
    }
  | { error: string };

/**
 * Startet die frische Eigenbestätigung eines Hardware-only-Administrators.
 * Challenge, Actor, Zielkonto und aktuelle Auth-Revision werden gemeinsam im
 * One-time-Store gebunden; die abschließende Action validiert alles erneut.
 */
export async function beginHardwareRecoveryStepUpAction(input: {
  targetUserId: string;
}): Promise<BeginHardwareRecoveryStepUpResult> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return { error: guard.error };
  const parsed = z.object({ targetUserId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: 'Ungültiges Zielkonto.' };
  const { tenantId, staffId, ctx, session } = guard;
  if (parsed.data.targetUserId === staffId) {
    return {
      error: isActualAdmin(session.user.roles)
        ? ADMIN_RECOVERY_CLI_ONLY
        : 'Der eigene Hardware-Zugang muss durch eine übergeordnete Rolle wiederhergestellt werden.',
    };
  }

  const limit = await checkRateLimit(
    `staff-hardware-recovery-stepup-begin:${staffId}`,
    RECOVERY_STEP_UP_BEGIN_LIMIT,
  );
  if (!limit.ok) return { error: 'Zu viele Versuche. Bitte warten Sie einige Minuten.' };

  try {
    const state = await withTenantContext(ctx, async (tx) => {
      const actor = await tx.staffUser.findFirst({
        where: { id: staffId, tenantId, active: true },
        select: {
          authRevision: true,
          hardwareOnlyEnabledAt: true,
          hardwareCredentials: {
            where: { revokedAt: null },
            select: { credentialId: true, transports: true },
          },
        },
      });
      const target = await tx.staffUser.findFirst({
        where: { id: parsed.data.targetUserId, tenantId },
        select: {
          hardwareOnlyEnabledAt: true,
          roles: { select: { role: true } },
        },
      });
      if (!actor?.hardwareOnlyEnabledAt || actor.hardwareCredentials.length === 0) {
        throw new ActionError(
          'Für Ihr Konto ist keine Bestätigung mit einem Sicherheitsschlüssel verfügbar.',
        );
      }
      if (!target) throw new ActionError('Benutzer nicht gefunden.');
      assertAccountRecoveryAllowed(session.user.roles, roleNames(target));
      if (!target.hardwareOnlyEnabledAt) {
        throw new ActionError('Für dieses Konto ist kein Hardware-only-Zugang aktiv.');
      }
      return actor;
    });

    return await beginHardwareModeAssertion({
      purpose: 'admin-recovery',
      staffId,
      tenantId,
      targetStaffId: parsed.data.targetUserId,
      authRevision: state.authRevision,
      credentials: state.hardwareCredentials,
    });
  } catch (error) {
    if (
      error instanceof HardwareAccessUnavailableError ||
      error instanceof HardwareAccessVerificationError
    ) {
      return { error: error.message };
    }
    return { error: toActionError(error).error };
  }
}

type RecoveryStepUpProof =
  | {
      method: 'password_totp';
      authRevision: number;
      passwordHash: string;
      totpSecretEnc: string;
      totpEnrolledAt: Date;
    }
  | {
      method: 'security_key';
      authRevision: number;
      hardwareOnlyEnabledAt: Date;
      credentialId: string;
      signCount: bigint;
      newSignCount: bigint;
      metadataSerial: bigint;
    };

type RecoveryActorState = {
  authRevision: number;
  passwordHash: string;
  hardwareOnlyEnabledAt: Date | null;
  totpSecretEnc: string | null;
  totpEnrolledAt: Date | null;
  hardwareCredentials: Array<{
    id: string;
    credentialId: string;
    aaguid: string | null;
    publicKey: Uint8Array;
    signCount: bigint;
    webauthnUserId: string;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
    attestationFormat: string;
    attestationVerifiedAt: Date;
    authenticatorVersion: bigint | null;
  }>;
};

async function verifyHardwareRecoveryStepUp(input: {
  actor: RecoveryActorState;
  targetUserId: string;
  staffId: string;
  tenantId: string;
  ceremonyId?: string;
  response?: AuthenticationResponseJSON;
}): Promise<RecoveryStepUpProof> {
  const hardwareOnlyEnabledAt = input.actor.hardwareOnlyEnabledAt;
  if (
    !hardwareOnlyEnabledAt ||
    !input.ceremonyId ||
    !input.response ||
    !isAuthenticationResponse(input.response)
  ) {
    throw new ActionError(RECOVERY_STEP_UP_FAILED);
  }
  const ceremony = await consumeHardwareCeremony({
    ceremonyId: input.ceremonyId,
    purpose: 'admin-recovery',
    staffId: input.staffId,
    tenantId: input.tenantId,
    targetStaffId: input.targetUserId,
    authRevision: input.actor.authRevision,
  });
  const key = input.actor.hardwareCredentials.find(
    (credential) => credential.credentialId === input.response!.id,
  );
  if (!key?.aaguid || !key.attestationFormat || !key.attestationVerifiedAt) {
    throw new ActionError(RECOVERY_STEP_UP_FAILED);
  }
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
    staffId: input.staffId,
  });
  return {
    method: 'security_key',
    authRevision: input.actor.authRevision,
    hardwareOnlyEnabledAt,
    credentialId: key.id,
    signCount: key.signCount,
    newSignCount: assertion.newSignCount,
    metadataSerial: assertion.metadataSerial,
  };
}

async function verifyPasswordTotpRecoveryStepUp(input: {
  actor: RecoveryActorState;
  staffId: string;
  tenantId: string;
  actorPassword?: string;
  actorTotpCode?: string;
}): Promise<RecoveryStepUpProof> {
  const { actorPassword, actorTotpCode } = input;
  const { totpSecretEnc, totpEnrolledAt } = input.actor;
  if (!actorPassword || !actorTotpCode || !totpSecretEnc || !totpEnrolledAt) {
    throw new ActionError(RECOVERY_STEP_UP_FAILED);
  }
  const passwordOk = await compare(actorPassword, input.actor.passwordHash);
  let totpOk: boolean;
  try {
    const secret = decryptTotpSecret(totpSecretEnc, input.tenantId, env.AUTH_SECRET);
    totpOk = verifyTotpCode(actorTotpCode, secret);
  } catch {
    throw new ActionError(RECOVERY_STEP_UP_FAILED);
  }
  if (!passwordOk || !totpOk) throw new ActionError(RECOVERY_STEP_UP_FAILED);
  const freshTotp = await consumeTotpCode(input.staffId, actorTotpCode);
  if (freshTotp !== true) throw new ActionError(RECOVERY_STEP_UP_FAILED);
  return {
    method: 'password_totp',
    authRevision: input.actor.authRevision,
    passwordHash: input.actor.passwordHash,
    totpSecretEnc,
    totpEnrolledAt,
  };
}

function assertRecoveryActorUnchanged(
  currentActor: {
    authRevision: number;
    passwordHash: string;
    hardwareOnlyEnabledAt: Date | null;
    totpSecretEnc: string | null;
    totpEnrolledAt: Date | null;
  } | null,
  proof: RecoveryStepUpProof,
): void {
  if (!currentActor || currentActor.authRevision !== proof.authRevision) {
    throw new ActionError('Ihr Anmeldezustand wurde geändert; Recovery abgebrochen.');
  }
  if (proof.method === 'security_key') {
    if (currentActor.hardwareOnlyEnabledAt?.getTime() !== proof.hardwareOnlyEnabledAt.getTime()) {
      throw new ActionError('Ihr Anmeldezustand wurde geändert; Recovery abgebrochen.');
    }
    return;
  }
  if (
    currentActor.hardwareOnlyEnabledAt ||
    currentActor.passwordHash !== proof.passwordHash ||
    currentActor.totpSecretEnc !== proof.totpSecretEnc ||
    currentActor.totpEnrolledAt?.getTime() !== proof.totpEnrolledAt.getTime()
  ) {
    throw new ActionError('Ihr Anmeldezustand wurde geändert; Recovery abgebrochen.');
  }
}

async function commitHardwareAccessRecovery(input: {
  ctx: TenantContext;
  tenantId: string;
  staffId: string;
  targetUserId: string;
  passwordHash: string;
  protectedRoles: StaffRole[];
  proof: RecoveryStepUpProof;
}): Promise<void> {
  await withTenantContext(input.ctx, async (tx) => {
    // Globale Sperrreihenfolge: erst FIDO-MDS, dann Actor/Target. Login,
    // Registrierung und Moduswechsel verwenden dieselbe Reihenfolge, damit
    // ein parallel wartendes MDS-Update keinen Sperrzyklus erzeugen kann.
    if (input.proof.method === 'security_key') {
      await lockMatchingHardwareMetadataSerial(tx, input.proof.metadataSerial);
    }
    const revokedCount = await revokeStaffHardwareCredentialsForRecovery(tx, input.targetUserId);
    if (revokedCount < 2) {
      throw new ActionError(
        'Der Hardware-Zugang enthält nicht die erforderlichen Sicherheitsschlüssel; Recovery abgebrochen.',
      );
    }
    // Die Definer-Prozedur hält Actor- und Target-Lock in stabiler Reihenfolge.
    // Erst danach wird der zum Step-up gehörende Actor-Zustand frisch gelesen;
    // jede zwischenzeitliche Faktor-/Modus-/Revisionsänderung rollt damit auch
    // den bereits ausgeführten Credential-Widerruf der Transaktion zurück.
    const currentActor = await tx.staffUser.findFirst({
      where: { id: input.staffId, tenantId: input.tenantId, active: true },
      select: {
        authRevision: true,
        passwordHash: true,
        hardwareOnlyEnabledAt: true,
        totpSecretEnc: true,
        totpEnrolledAt: true,
      },
    });
    assertRecoveryActorUnchanged(currentActor, input.proof);

    if (input.proof.method === 'security_key') {
      const keyUpdated = await tx.staffWebAuthnCredential.updateMany({
        where: {
          id: input.proof.credentialId,
          tenantId: input.tenantId,
          staffUserId: input.staffId,
          revokedAt: null,
          signCount: input.proof.signCount,
        },
        data: { signCount: input.proof.newSignCount, lastUsedAt: new Date() },
      });
      if (keyUpdated.count !== 1) {
        throw new ActionError('Der Sicherheitsschlüssel wurde parallel verwendet.');
      }
    }

    const updated = await tx.staffUser.updateMany({
      where: {
        id: input.targetUserId,
        tenantId: input.tenantId,
        hardwareOnlyEnabledAt: { not: null },
        roles: { none: { role: { in: input.protectedRoles } } },
      },
      data: {
        passwordHash: input.passwordHash,
        hardwareOnlyEnabledAt: null,
        totpSecretEnc: null,
        totpEnrolledAt: null,
        totpSetupStartedAt: null,
        totpBackupCodes: Prisma.DbNull,
        failedLoginCount: 0,
        lockedUntil: null,
        authRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new ActionError(
        'Kontozustand oder Rollen wurden parallel geändert; Recovery abgebrochen.',
      );
    }
    await evidenceService.record(tx, {
      tenantId: input.tenantId,
      actorType: 'STAFF',
      actorId: input.staffId,
      action: 'staff.hardware_access.reset',
      resourceType: 'staff_user',
      resourceId: input.targetUserId,
      before: { mode: 'hardware_only', activeSecurityKeys: revokedCount },
      after: {
        mode: 'password_totp_setup_required',
        activeSecurityKeys: 0,
        changedBy: 'admin',
        stepUpMethod: input.proof.method,
      },
    });
  });
}

export async function recoverHardwareAccessAction(input: {
  targetUserId: string;
  newPassword: string;
  confirmPassword: string;
  actorPassword?: string;
  actorTotpCode?: string;
  ceremonyId?: string;
  response?: AuthenticationResponseJSON;
}): Promise<ActionResult> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx, session } = guard;
  const parsed = z
    .object({
      targetUserId: z.string().uuid(),
      newPassword: z.string(),
      confirmPassword: z.string(),
      actorPassword: z.string().max(4096).optional(),
      actorTotpCode: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
      ceremonyId: z.string().max(128).optional(),
    })
    .safeParse({
      targetUserId: input?.targetUserId,
      newPassword: input?.newPassword,
      confirmPassword: input?.confirmPassword,
      actorPassword: input?.actorPassword,
      actorTotpCode: input?.actorTotpCode,
      ceremonyId: input?.ceremonyId,
    });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const validationError = validateStaffPasswordPair(
    parsed.data.newPassword,
    parsed.data.confirmPassword,
  );
  if (validationError) return { ok: false, error: validationError };
  if (parsed.data.targetUserId === staffId) {
    return {
      ok: false,
      error: isActualAdmin(session.user.roles)
        ? ADMIN_RECOVERY_CLI_ONLY
        : 'Der eigene Hardware-Zugang muss durch eine übergeordnete Rolle wiederhergestellt werden.',
    };
  }

  const stepUpLimit = await checkRateLimit(
    `staff-hardware-recovery-stepup:${staffId}`,
    RECOVERY_STEP_UP_LIMIT,
  );
  if (!stepUpLimit.ok) {
    return { ok: false, error: 'Zu viele Versuche. Bitte warten Sie einige Minuten.' };
  }

  try {
    const state = await withTenantContext(ctx, async (tx) => {
      const actor = await tx.staffUser.findFirst({
        where: { id: staffId, tenantId, active: true },
        select: {
          authRevision: true,
          passwordHash: true,
          hardwareOnlyEnabledAt: true,
          totpSecretEnc: true,
          totpEnrolledAt: true,
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
      });
      const target = await tx.staffUser.findFirst({
        where: { id: parsed.data.targetUserId, tenantId },
        select: {
          hardwareOnlyEnabledAt: true,
          roles: { select: { role: true } },
        },
      });
      return { actor, target };
    });
    if (!state.actor) throw new ActionError(RECOVERY_STEP_UP_FAILED);
    if (!state.target) throw new ActionError('Benutzer nicht gefunden.');
    assertAccountRecoveryAllowed(session.user.roles, roleNames(state.target));
    if (!state.target.hardwareOnlyEnabledAt) {
      throw new ActionError('Für dieses Konto ist kein Hardware-only-Zugang aktiv.');
    }

    const proof = state.actor.hardwareOnlyEnabledAt
      ? await verifyHardwareRecoveryStepUp({
          actor: state.actor,
          targetUserId: parsed.data.targetUserId,
          staffId,
          tenantId,
          ceremonyId: parsed.data.ceremonyId,
          response: input.response,
        })
      : await verifyPasswordTotpRecoveryStepUp({
          actor: state.actor,
          staffId,
          tenantId,
          actorPassword: parsed.data.actorPassword,
          actorTotpCode: parsed.data.actorTotpCode,
        });

    const passwordHash = await hash(parsed.data.newPassword, 12);
    // Der Moduswechsel samt authRevision-Inkrement ist hier der autoritative
    // Session-Cutoff. Ein vorgelagerter externer Widerruf könnte bei einer
    // anschließend unter DB-Locks abgewiesenen Recovery einen unberechtigten
    // Logout des Zielkontos hinterlassen.
    await commitHardwareAccessRecovery({
      ctx,
      tenantId,
      staffId,
      targetUserId: parsed.data.targetUserId,
      passwordHash,
      protectedRoles: accountRecoveryProtectedRoles(session.user.roles),
      proof,
    });
  } catch (error) {
    if (error instanceof HardwareAccessUnavailableError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof HardwareAccessVerificationError) {
      return { ok: false, error: RECOVERY_STEP_UP_FAILED };
    }
    return toActionError(error);
  }

  revalidatePath(LIST);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Aktiv/Inaktiv
// ----------------------------------------------------------------------------

export async function setActiveAction(input: {
  userId: string;
  active: boolean;
}): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z.object({ userId: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.userId === staffId) {
    return { ok: false, error: 'Eigenen Account nicht deaktivieren.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      const before = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: { active: true, roles: { select: { role: true } } },
      });
      if (!before) throw new ActionError('Benutzer nicht gefunden.');
      assertPartnerCannotManageAdmin(session.user.roles, roleNames(before));
      if (!parsed.data.active) {
        await revokeAllSessions('staff', parsed.data.userId);
      }
      if (isActualAdmin(session.user.roles)) {
        await tx.staffUser.update({
          where: { id: parsed.data.userId },
          data: { active: parsed.data.active },
        });
      } else {
        const updated = await tx.staffUser.updateMany({
          where: { id: parsed.data.userId, roles: { none: { role: 'ADMIN' } } },
          data: { active: parsed.data.active },
        });
        if (updated.count !== 1) {
          throw new ActionError('Kontorollen wurden parallel geändert; Änderung abgebrochen.');
        }
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: parsed.data.active ? 'staff.activate' : 'staff.deactivate',
        resourceType: 'staff_user',
        resourceId: parsed.data.userId,
        before: { active: before.active },
        after: { active: parsed.data.active },
      });
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(LIST);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Rollen setzen
// ----------------------------------------------------------------------------

export async function setRolesAction(input: {
  userId: string;
  roles: string[];
}): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z
    .object({
      userId: z.string().uuid(),
      // Befund 14: min(1) — ein leeres Array würde sonst ALLE Rollen entfernen
      // und den User effektiv funktionslos machen.
      roles: z.array(z.enum(ROLE_VALUES)).min(1, 'Mindestens eine Rolle muss zugewiesen bleiben.'),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  if (parsed.data.userId === staffId) {
    return { ok: false, error: 'Eigene Rollen nicht ändern.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      await lockStaffAccountRecovery(tx, parsed.data.userId);
      const before = await tx.staffRole.findMany({ where: { staffUserId: parsed.data.userId } });
      const beforeRoles = before.map((b) => b.role);
      const actorIsAdmin = isActualAdmin(session.user.roles);
      if (!actorIsAdmin && (beforeRoles.includes('ADMIN') || parsed.data.roles.includes('ADMIN'))) {
        throw new ActionError('Die ADMIN-Rolle kann nur durch einen ADMIN verwaltet werden.');
      }
      if (beforeRoles.includes('ADMIN') && !parsed.data.roles.includes('ADMIN')) {
        throw new ActionError('Die ADMIN-Rolle darf in der Web-Oberfläche nicht entzogen werden.');
      }
      if (
        !actorIsAdmin &&
        beforeRoles.includes('PARTNER') &&
        !parsed.data.roles.includes('PARTNER')
      ) {
        throw new ActionError('Die PARTNER-Rolle kann nur durch einen ADMIN entzogen werden.');
      }
      const newSet = new Set(parsed.data.roles);
      const oldSet = new Set(beforeRoles);
      const toRemove = beforeRoles.filter((r) => !newSet.has(r));
      const toAdd = parsed.data.roles.filter((r) => !oldSet.has(r));

      if (toAdd.length > 0 || toRemove.length > 0) {
        await revokeAllSessions('staff', parsed.data.userId);
      }
      if (toRemove.length > 0) {
        await tx.staffRole.deleteMany({
          where: { staffUserId: parsed.data.userId, role: { in: toRemove } },
        });
      }
      for (const r of toAdd) {
        await tx.staffRole.create({ data: { staffUserId: parsed.data.userId, role: r } });
      }
      if (toAdd.length > 0 || toRemove.length > 0) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'staff.roles.update',
          resourceType: 'staff_user',
          resourceId: parsed.data.userId,
          before: { roles: beforeRoles },
          after: { roles: parsed.data.roles },
        });
      }
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(LIST);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Einzelrechte setzen (iter87) — zulässige Werte aus der zentralen Quelle.
// ----------------------------------------------------------------------------

export async function setPermissionsAction(input: {
  userId: string;
  permissions: string[];
}): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z
    .object({
      userId: z.string().uuid(),
      // Leeres Array ist hier ERLAUBT (anders als Rollen): alle Einzelrechte
      // entziehen ist ein legitimer Zustand — ADMIN/PARTNER bleiben implizit.
      permissions: z.array(z.enum(STAFF_PERMISSION_VALUES)),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  if (parsed.data.userId === staffId) {
    return { ok: false, error: 'Eigene Berechtigungen nicht ändern.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      // Existenz + Tenant-Zugehörigkeit prüfen: das leere permissions-Array ist
      // erlaubt und schreibt ggf. gar nichts — ohne diese Prüfung würde die
      // Action für eine fremde/erfundene userId mit ok:true enden (RLS schlägt
      // mangels Write nie an) und der Revoke ins Leere feuern.
      const target = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: { id: true },
      });
      if (!target) throw new ActionError('Benutzer nicht gefunden.');

      const before = await tx.staffPermission.findMany({
        where: { staffUserId: parsed.data.userId },
      });
      const beforePerms = before.map((b) => b.permission);
      const newSet = new Set(parsed.data.permissions);
      const oldSet = new Set(beforePerms);
      const toRemove = beforePerms.filter((p) => !newSet.has(p));
      const toAdd = parsed.data.permissions.filter((p) => !oldSet.has(p));

      // Nur Entzug braucht einen Cutoff. Erweiterungen werden ohnehin aus dem
      // frischen DB-Stand geladen. Widerruf muss vor dem Delete bestaetigt sein.
      if (toRemove.length > 0) {
        await revokeAllSessions('staff', parsed.data.userId);
      }
      if (toRemove.length > 0) {
        await tx.staffPermission.deleteMany({
          where: { staffUserId: parsed.data.userId, permission: { in: toRemove } },
        });
      }
      for (const p of toAdd) {
        await tx.staffPermission.create({
          data: { staffUserId: parsed.data.userId, permission: p, grantedBy: staffId },
        });
      }
      if (toAdd.length > 0 || toRemove.length > 0) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'staff.permissions.update',
          resourceType: 'staff_user',
          resourceId: parsed.data.userId,
          before: { permissions: beforePerms },
          after: { permissions: parsed.data.permissions },
        });
      }
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(LIST);
  return { ok: true };
}
