'use server';

import { z } from 'zod';
import { evidenceService } from '@/server/container';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

const REVALIDATE = '/staff/admin/email-templates';

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
  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const data = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      if (data.id) {
        const before = await tx.emailTemplate.findUnique({ where: { id: data.id } });
        if (!before) throw new ActionError('Vorlage nicht gefunden.');
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
        if (dup) throw new ActionError('Name bereits vergeben.');
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
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

export async function deleteEmailTemplateAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const t = await tx.emailTemplate.findUnique({ where: { id: parsed.data.id } });
      if (!t) throw new ActionError('Vorlage nicht gefunden.');
      if (t.slug) throw new ActionError('System-Vorlagen können nicht gelöscht werden.');
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
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}
