'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { hash } from 'bcryptjs';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { revokeAllSessions } from '@/server/auth/revocation';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { seedDefaultRssFeeds } from '@/server/rss/defaults';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

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

  const { tenantId, staffId } = session.user;
  const passwordHash = await hash(parsed.data.password, 12);

  const roles: Array<'EMPLOYEE' | 'PARTNER' | 'ADMIN'> = ['EMPLOYEE'];
  if (parsed.data.partner) roles.push('PARTNER');
  if (parsed.data.admin) roles.push('ADMIN');

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const existing = await tx.staffUser.findFirst({
          where: { email: parsed.data.email },
          select: { id: true },
        });
        if (existing) throw new Error('E-Mail bereits vergeben.');

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
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  revalidatePath('/staff/admin/users');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Aktiv/Inaktiv
// ----------------------------------------------------------------------------

export async function setActiveAction(input: { userId: string; active: boolean }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = z.object({ userId: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.userId === session.user.staffId) {
    return { ok: false, error: 'Eigenen Account nicht deaktivieren.' };
  }

  const { tenantId, staffId } = session.user;
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.staffUser.findUnique({
        where: { id: parsed.data.userId },
        select: { active: true },
      });
      if (!before) throw new Error('Benutzer nicht gefunden.');
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
    },
  );
  // S11: Deaktivierung sofort wirksam — alle Sessions des Users revoken.
  if (!parsed.data.active) {
    await revokeAllSessions('staff', parsed.data.userId);
  }
  revalidatePath('/staff/admin/users');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Rollen setzen
// ----------------------------------------------------------------------------

export async function setRolesAction(input: { userId: string; roles: string[] }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = z
    .object({
      userId: z.string().uuid(),
      roles: z.array(z.enum(ROLE_VALUES)),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.userId === session.user.staffId) {
    return { ok: false, error: 'Eigene Rollen nicht ändern.' };
  }

  const { tenantId, staffId } = session.user;
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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
    },
  );
  // S11: Rollen-Entzug muss sofort wirksam werden (z. B. ADMIN-Bit zurückgenommen).
  // Tokens im Umlauf hätten sonst noch die alten Claims bis zu 24h.
  await revokeAllSessions('staff', parsed.data.userId);
  revalidatePath('/staff/admin/users');
  return { ok: true };
}
