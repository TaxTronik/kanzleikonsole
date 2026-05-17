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

export async function toggleTaxNewsNotifyAction(input: { enabled: boolean }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      await tx.staffUser.update({
        where: { id: staffId },
        data: { taxNewsNotify: parsed.data.enabled },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: parsed.data.enabled ? 'staff.tax_news.opt_in' : 'staff.tax_news.opt_out',
        resourceType: 'staff_user',
        resourceId: staffId,
        after: { taxNewsNotify: parsed.data.enabled },
      });
    },
  );

  revalidatePath('/staff/dashboard');
  return { ok: true };
}

/**
 * Admin/Partner-only: zieht JETZT die RSS-Feeds (für manuelles Testen).
 * Im Produktivbetrieb läuft das täglich automatisch via Worker.
 */
export async function triggerTaxNewsFetchAction(): Promise<
  ActionResult & { inserted?: number; fetched?: number; errors?: string[] }
> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) {
    return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  }
  try {
    const mod = await import('@/server/tax-news/fetcher');
    const result = await mod.fetchAndPersistTaxNews();
    revalidatePath('/staff/dashboard');
    return {
      ok: true,
      inserted: result.inserted,
      fetched: result.fetched,
      errors: result.errors,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

