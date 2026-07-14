'use server';

import { z } from 'zod';
import { evidenceService } from '@/server/container';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

const REVALIDATE = '/staff/admin/request-templates';

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
  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      if (data.id) {
        const before = await tx.requestTemplate.findUnique({ where: { id: data.id } });
        if (!before) throw new ActionError('Vorlage nicht gefunden.');
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
        if (dup) throw new ActionError('Name bereits vergeben.');
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
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

export async function deleteRequestTemplateAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const t = await tx.requestTemplate.findUnique({ where: { id: parsed.data.id } });
      if (!t) throw new ActionError('Vorlage nicht gefunden.');
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
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}
