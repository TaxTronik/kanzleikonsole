'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const SaveSchema = z.object({
  id: z.string().uuid().nullable(),
  name: z.string().min(2).max(120),
  category: z.string().max(60).nullable(),
  title: z.string().min(2).max(200),
  description: z.string().min(2).max(5000),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  dueAfterDays: z.number().int().min(0).max(365).nullable(),
  formTemplateId: z.string().uuid().nullable(),
  active: z.boolean(),
});

export async function saveRequestTemplateAction(
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
          const before = await tx.requestTemplate.findUnique({ where: { id: data.id } });
          if (!before) throw new Error('Vorlage nicht gefunden.');
          await tx.requestTemplate.update({
            where: { id: data.id },
            data: {
              name: data.name,
              category: data.category,
              title: data.title,
              description: data.description,
              priority: data.priority,
              dueAfterDays: data.dueAfterDays,
              formTemplateId: data.formTemplateId,
              active: data.active,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'request_template.update',
            resourceType: 'request_template',
            resourceId: data.id,
            before,
            after: data,
          });
        } else {
          const dup = await tx.requestTemplate.findFirst({ where: { name: data.name } });
          if (dup) throw new Error('Name bereits vergeben.');
          const last = await tx.requestTemplate.findFirst({
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true },
          });
          const created = await tx.requestTemplate.create({
            data: {
              tenantId,
              name: data.name,
              category: data.category,
              title: data.title,
              description: data.description,
              priority: data.priority,
              dueAfterDays: data.dueAfterDays,
              formTemplateId: data.formTemplateId,
              active: data.active,
              sortOrder: (last?.sortOrder ?? 0) + 10,
              createdByStaff: staffId,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'request_template.create',
            resourceType: 'request_template',
            resourceId: created.id,
            after: data,
          });
        }
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/request-templates');
  return { ok: true };
}

export async function deleteRequestTemplateAction(input: { id: string }): Promise<ActionResult> {
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
        const t = await tx.requestTemplate.findUnique({ where: { id: parsed.data.id } });
        if (!t) throw new Error('Vorlage nicht gefunden.');
        await tx.requestTemplate.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'request_template.delete',
          resourceType: 'request_template',
          resourceId: parsed.data.id,
          before: { name: t.name, title: t.title },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/request-templates');
  return { ok: true };
}
