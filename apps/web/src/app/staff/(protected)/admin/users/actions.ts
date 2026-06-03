'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { hash } from 'bcryptjs';
import { revokeAllSessions } from '@/server/auth/revocation';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { seedDefaultRssFeeds } from '@/server/rss/defaults';
import { toActionError } from '@/server/auth/rbac';
import { staffActionGuard, ActionError, type ActionResult } from '@/server/actions/staff-action';

const LIST = '/staff/admin/users';
const ROLE_VALUES = ['EMPLOYEE', 'PARTNER', 'ADMIN'] as const;

// ----------------------------------------------------------------------------
// Anlegen
// ----------------------------------------------------------------------------

const CreateSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(255),
  password: z.string().min(12).max(200),
  partner: z.boolean(),
  admin: z.boolean(),
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
// Aktiv/Inaktiv
// ----------------------------------------------------------------------------

export async function setActiveAction(input: { userId: string; active: boolean }): Promise<ActionResult> {
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

export async function setRolesAction(input: { userId: string; roles: string[] }): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = z
    .object({ userId: z.string().uuid(), roles: z.array(z.enum(ROLE_VALUES)) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
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
