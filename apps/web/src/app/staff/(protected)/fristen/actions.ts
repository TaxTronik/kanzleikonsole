'use server';

// Fachkatalog: TAX-CONTROL-STATUS-001

import { z } from 'zod';
import { withStaff, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';
import { parseFormData } from '@/server/actions/form-data';
import { createDailyReviewTx } from '@/server/fristen/tagesabschluss';

const CompleteSchema = z.object({
  escalationNote: z.string().max(4000).optional().or(z.literal('')),
});

export interface DailyReviewActionResult extends BaseActionResult {
  reviewId?: string;
  openCount?: number;
  overdueCount?: number;
  dueTodayCount?: number;
}

export async function completeDailyReviewAction(
  _prev: DailyReviewActionResult | null,
  formData: FormData,
): Promise<DailyReviewActionResult> {
  const parsed = parseFormData(CompleteSchema, formData);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
    };
  }

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const review = await createDailyReviewTx(tx, {
        tenantId,
        staffId,
        session,
        escalationNote: parsed.data.escalationNote,
      });
      return {
        reviewId: review.id,
        openCount: review.openCount,
        overdueCount: review.overdueCount,
        dueTodayCount: review.dueTodayCount,
      };
    },
    {
      requireAdmin: true,
      // Alle Fristquellen und der anschließende Insert teilen denselben
      // Postgres-Snapshot. `snapshot_at` dokumentiert dessen DB-seitigen
      // Transaktionsbeginn getrennt vom späteren Abschlusszeitpunkt.
      transactionIsolationLevel: 'RepeatableRead',
      uniqueError: 'Die Abschlusskontrolle für heute wurde bereits dokumentiert.',
      revalidate: '/staff/fristen',
    },
  );
}
