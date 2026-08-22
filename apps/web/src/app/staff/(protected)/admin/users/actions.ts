'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { hash } from 'bcryptjs';
import { revokeAllSessions } from '@/server/auth/revocation';
import { Prisma, withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { seedDefaultRssFeeds } from '@/server/rss/defaults';
import { toActionError } from '@/server/auth/rbac';
import { STAFF_PERMISSION_VALUES } from '@/lib/staff-permissions';
import { validateStaffPasswordPair } from '@/lib/staff-password-policy';
import { staffActionGuard, ActionError, type ActionResult } from '@/server/actions/staff-action';

const LIST = '/staff/admin/users';
const ROLE_VALUES = ['EMPLOYEE', 'PARTNER', 'ADMIN'] as const;

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
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  const passwordHash = await hash(parsed.data.password, 12);

  const roles: Array<'EMPLOYEE' | 'PARTNER' | 'ADMIN'> = ['EMPLOYEE'];
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
        after: { fullName: parsed.data.fullName, email: parsed.data.email, roles },
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

export async function resetPasswordAction(input: {
  userId: string;
  password: string;
  confirmPassword: string;
}): Promise<ActionResult> {
  // Gate vor bcrypt: nicht autorisierte Requests dürfen keine teure Arbeit auslösen.
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx } = guard;

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
      tx.staffUser.findUnique({ where: { id: parsed.data.userId }, select: { id: true } }),
    );
    if (!target) throw new ActionError('Benutzer nicht gefunden.');

    const passwordHash = await hash(parsed.data.password, 12);
    await withTenantContext(ctx, async (tx) => {
      await tx.staffUser.update({
        where: { id: parsed.data.userId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff.password.reset',
        resourceType: 'staff_user',
        resourceId: parsed.data.userId,
        after: { changedBy: 'admin' },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  await revokeAllSessions('staff', parsed.data.userId);
  revalidatePath(LIST);
  return { ok: true };
}

export async function resetTotpAction(input: { userId: string }): Promise<ActionResult> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx } = guard;

  const parsed = z.object({ userId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.userId === staffId) {
    return { ok: false, error: 'Die eigene 2FA muss ein anderer Admin zurücksetzen.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      const before = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: {
          totpEnrolledAt: true,
          totpSecretEnc: true,
          totpSetupStartedAt: true,
          totpBackupCodes: true,
        },
      });
      if (!before) throw new ActionError('Benutzer nicht gefunden.');
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

      await tx.staffUser.update({
        where: { id: parsed.data.userId },
        data: {
          totpSecretEnc: null,
          totpEnrolledAt: null,
          totpSetupStartedAt: null,
          totpBackupCodes: Prisma.DbNull,
        },
      });
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
        after: { enrolled: false, setupPending: false },
      });
    });
  } catch (error) {
    return toActionError(error);
  }

  await revokeAllSessions('staff', parsed.data.userId);
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
  const { tenantId, staffId, ctx } = g;

  const parsed = z.object({ userId: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.userId === staffId) {
    return { ok: false, error: 'Eigenen Account nicht deaktivieren.' };
  }

  try {
    await withTenantContext(ctx, async (tx) => {
      const before = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: { active: true },
      });
      if (!before) throw new ActionError('Benutzer nicht gefunden.');
      await tx.staffUser.update({
        where: { id: parsed.data.userId },
        data: { active: parsed.data.active },
      });
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
  // S11: Deaktivierung sofort wirksam — alle Sessions des Users revoken.
  if (!parsed.data.active) {
    await revokeAllSessions('staff', parsed.data.userId);
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
  const { tenantId, staffId, ctx } = g;

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
      const before = await tx.staffRole.findMany({ where: { staffUserId: parsed.data.userId } });
      const beforeRoles = before.map((b) => b.role);
      const newSet = new Set(parsed.data.roles);
      const oldSet = new Set(beforeRoles);
      const toRemove = beforeRoles.filter((r) => !newSet.has(r));
      const toAdd = parsed.data.roles.filter((r) => !oldSet.has(r));

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
  // S11: Rollen-Entzug muss sofort wirksam werden (z. B. ADMIN-Bit zurückgenommen).
  // Tokens im Umlauf hätten sonst noch die alten Claims bis zu 24h.
  await revokeAllSessions('staff', parsed.data.userId);
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
    const revoke = await withTenantContext(ctx, async (tx) => {
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
      // Revoke nur bei ENTZUG: Erweiterungen greifen beim nächsten Request von
      // selbst (Session lädt Rechte frisch), und der DB-Fallback verweigert ein
      // erweitertes Recht dort sicher (fail-closed). Entzug dagegen bliebe im
      // alten Token bis zu 24 h wirksam → Sofort-Logout.
      return toRemove.length > 0;
    });
    if (revoke) {
      await revokeAllSessions('staff', parsed.data.userId);
    }
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(LIST);
  return { ok: true };
}
