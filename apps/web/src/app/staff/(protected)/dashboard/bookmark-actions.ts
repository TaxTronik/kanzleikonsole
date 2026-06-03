'use server';

import { z } from 'zod';
import { withStaff, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

export interface ActionResult extends BaseActionResult {
  bookmarked?: boolean;
}

/**
 * S-2: href-Scheme-Validation. Server-Action kann via direkten fetch/curl mit
 * gültigem Cookie aufgerufen werden — die BookmarkButton-UI ist nur ein
 * möglicher Caller. Ohne Filter persistiert die Action beliebige Schemes
 * (javascript:, data:, file:, externe Origins) ins staff_bookmark.href.
 * Aktuelles Rendering ist React 19 (blockt javascript: in href), aber:
 *  - Mail-/CSV-Exporte der Bookmarks könnten den Wert weniger streng rendern
 *  - Audit-UI rendert href als <a>-Link
 *  - React-Verhalten kann in Minor-Versionen kippen
 * → wir filtern am Schreibpunkt.
 */
const SafeHref = z
  .string()
  .max(2000)
  .nullable()
  .optional()
  .refine(
    (s) => s == null || /^(https?:\/\/|\/)/.test(s),
    'Nur http(s)://… oder /-relative URLs erlaubt.',
  );

const ToggleSchema = z.object({
  resourceType: z.string().min(1).max(60),
  resourceId: z.string().uuid(),
  label: z.string().min(1).max(500),
  href: SafeHref,
});

/**
 * Toggle: gibt es schon ein Bookmark für (staff, resourceType, resourceId)?
 *   → löschen.
 * Sonst neu anlegen.
 */
export async function toggleBookmarkAction(input: z.infer<typeof ToggleSchema>): Promise<ActionResult> {
  const parsed = ToggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { resourceType, resourceId, label, href } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const existing = await tx.staffBookmark.findUnique({
        where: { staffId_resourceType_resourceId: { staffId, resourceType, resourceId } },
      });
      if (existing) {
        await tx.staffBookmark.delete({ where: { id: existing.id } });
        return { bookmarked: false };
      }
      await tx.staffBookmark.create({
        data: {
          tenantId,
          staffId,
          resourceType,
          resourceId,
          label,
          href: href ?? null,
        },
      });
      return { bookmarked: true };
    },
    { revalidate: '/staff/dashboard' },
  );
}

export async function removeBookmarkAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { staffId }) => {
      await tx.staffBookmark.deleteMany({
        where: { id: parsed.data.id, staffId },
      });
    },
    { revalidate: '/staff/dashboard' },
  );
}
