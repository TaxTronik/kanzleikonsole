'use server';

import { z } from 'zod';
import { slugify as slugifyLib } from '@/lib/slugify';
import { evidenceService } from '@/server/container';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';

function slugify(s: string): string {
  return slugifyLib(s, { separator: '-', maxLength: 60 });
}

const REVALIDATE = '/staff/admin/invoice-categories';
const UNIQUE_ERR = 'Ein Rechnungstyp mit diesem Slug existiert bereits.';

const SaveSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional().or(z.literal('')),
  emailTemplateSlug: z.string().max(80).optional().or(z.literal('')),
  active: z.boolean(),
});

export async function saveInvoiceCategoryAction(input: z.infer<typeof SaveSchema>): Promise<ActionResult> {
  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const slug = parsed.data.slug && parsed.data.slug.trim() ? slugify(parsed.data.slug) : slugify(parsed.data.name);
  if (!slug) return { ok: false, error: 'Slug konnte nicht erzeugt werden.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      if (parsed.data.id) {
        await tx.invoiceCategory.update({
          where: { id: parsed.data.id },
          data: {
            name: parsed.data.name.trim(),
            slug,
            emailTemplateSlug: parsed.data.emailTemplateSlug?.trim() || null,
            active: parsed.data.active,
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'invoice_category.update',
          resourceType: 'invoice_category',
          resourceId: parsed.data.id,
          after: { name: parsed.data.name, slug, active: parsed.data.active },
        });
      } else {
        const last = await tx.invoiceCategory.findFirst({
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const created = await tx.invoiceCategory.create({
          data: {
            tenantId,
            name: parsed.data.name.trim(),
            slug,
            emailTemplateSlug: parsed.data.emailTemplateSlug?.trim() || null,
            active: parsed.data.active,
            sortOrder: (last?.sortOrder ?? 0) + 10,
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'invoice_category.create',
          resourceType: 'invoice_category',
          resourceId: created.id,
          after: { name: parsed.data.name, slug },
        });
      }
    },
    { requireAdmin: true, uniqueError: UNIQUE_ERR, revalidate: REVALIDATE },
  );
}

export async function deleteInvoiceCategoryAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const c = await tx.invoiceCategory.findUnique({ where: { id: parsed.data.id } });
      await tx.invoiceCategory.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId, actorType: 'STAFF', actorId: staffId,
        action: 'invoice_category.delete',
        resourceType: 'invoice_category',
        resourceId: parsed.data.id,
        before: { name: c?.name ?? null, slug: c?.slug ?? null },
      });
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}
