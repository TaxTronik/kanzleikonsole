'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult { ok: boolean; error?: string; }

const SaveSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().min(2).max(120),
  category: z.string().max(60).nullable(),
  subject: z.string().min(2).max(200),
  bodyMd: z.string().min(2).max(10_000),
  active: z.boolean(),
});

export async function saveEmailTemplateAction(
  input: z.infer<typeof SaveSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const data = parsed.data;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        if (data.id) {
          const before = await tx.emailTemplate.findUnique({ where: { id: data.id } });
          if (!before) throw new Error('Vorlage nicht gefunden.');
          await tx.emailTemplate.update({
            where: { id: data.id },
            data: {
              name: data.name,
              category: data.category,
              subject: data.subject,
              bodyMd: data.bodyMd,
              active: data.active,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'email_template.update',
            resourceType: 'email_template',
            resourceId: data.id,
            before: { name: before.name, subject: before.subject },
            after: { name: data.name, subject: data.subject },
          });
        } else {
          // S7: expliziter tenantId-Filter (Defense in Depth + lesbarere Intent).
          const dup = await tx.emailTemplate.findFirst({ where: { tenantId, name: data.name } });
          if (dup) throw new Error('Name bereits vergeben.');
          const last = await tx.emailTemplate.findFirst({
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true },
          });
          const created = await tx.emailTemplate.create({
            data: {
              tenantId,
              name: data.name,
              category: data.category,
              subject: data.subject,
              bodyMd: data.bodyMd,
              active: data.active,
              sortOrder: (last?.sortOrder ?? 0) + 10,
              createdByStaff: staffId,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'email_template.create',
            resourceType: 'email_template',
            resourceId: created.id,
            after: { name: data.name, subject: data.subject },
          });
        }
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/email-templates');
  return { ok: true };
}

export async function deleteEmailTemplateAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const t = await tx.emailTemplate.findUnique({ where: { id: parsed.data.id } });
        if (!t) throw new Error('Vorlage nicht gefunden.');
        if (t.slug) throw new Error('System-Vorlagen können nicht gelöscht werden.');
        await tx.emailTemplate.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'email_template.delete',
          resourceType: 'email_template',
          resourceId: parsed.data.id,
          before: { name: t.name, subject: t.subject },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/email-templates');
  return { ok: true };
}
