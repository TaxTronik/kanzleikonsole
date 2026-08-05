'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { toActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import {
  staffActionGuard,
  withStaff,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

export type ActionResult = BaseActionResult;

export async function toggleTaxNewsNotifyAction(input: {
  enabled: boolean;
}): Promise<ActionResult> {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
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
    { revalidate: '/staff/dashboard' },
  );
}

/** Zieht die eigenen aktiven RSS-Feeds des angemeldeten Mitarbeiters. */
export async function triggerTaxNewsFetchAction(): Promise<
  ActionResult & { inserted?: number; fetched?: number; errors?: string[] }
> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  try {
    const mod = await import('@/server/tax-news/fetcher');
    const result = await mod.fetchAndPersistTaxNews({
      tenantId: g.tenantId,
      staffId: g.staffId,
    });
    revalidatePath('/staff/dashboard');
    return {
      ok: true,
      inserted: result.inserted,
      fetched: result.fetched,
      errors: result.errors,
    };
  } catch (e) {
    return toActionError(e);
  }
}
