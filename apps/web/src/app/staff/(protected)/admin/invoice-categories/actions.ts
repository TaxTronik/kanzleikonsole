'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult { ok: boolean; error?: string; }

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const SaveSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional().or(z.literal('')),
  emailTemplateSlug: z.string().max(80).optional().or(z.literal('')),
  active: z.boolean(),
});

export async function saveInvoiceCategoryAction(input: z.infer<typeof SaveSchema>): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) {
    return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  }
  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const slug = parsed.data.slug && parsed.data.slug.trim() ? slugify(parsed.data.slug) : slugify(parsed.data.name);
  if (!slug) return { ok: false, error: 'Slug konnte nicht erzeugt werden.' };

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
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
    );
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Ein Rechnungstyp mit diesem Slug existiert bereits.' };
    }
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/invoice-categories');
  return { ok: true };
}

export async function deleteInvoiceCategoryAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) {
    return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  }
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
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
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/invoice-categories');
  return { ok: true };
}
