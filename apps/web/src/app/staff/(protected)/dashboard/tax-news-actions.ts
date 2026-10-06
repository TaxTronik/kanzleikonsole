'use server';

import { z } from 'zod';
import {
  staffAction,
  withStaffModule,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';

const withRssReaderStaff = withStaffModule('rssReader');

export type ActionResult = BaseActionResult;

export async function toggleTaxNewsNotifyAction(input: {
  enabled: boolean;
}): Promise<ActionResult> {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withRssReaderStaff(
    async (tx, { staffId, ctx }) => {
      await tx.staffUser.update({
        where: { id: staffId },
        data: { taxNewsNotify: parsed.data.enabled },
      });
      await audit(tx, ctx, {
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
  return staffAction({
    guard: { module: 'rssReader' },
    run: async (g) => {
      const mod = await import('@/server/tax-news/fetcher');
      const result = await mod.fetchAndPersistTaxNews({
        tenantId: g.tenantId,
        staffId: g.staffId,
      });
      return {
        inserted: result.inserted,
        fetched: result.fetched,
        errors: result.errors,
      };
    },
    revalidate: '/staff/dashboard',
  });
}
