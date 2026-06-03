'use server';

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { WIDGET_BY_TYPE, type DashboardLayout } from '@/server/dashboard/widgets';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';

export type { ActionResult };

const LayoutSchema = z.object({
  version: z.literal(2),
  widgets: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        type: z.string().min(1).max(60),
        x: z.number().int().min(0).max(48),
        y: z.number().int().min(0).max(200),
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(1).max(40),
      }),
    )
    .max(40),
});

export async function saveDashboardLayoutAction(layout: DashboardLayout): Promise<ActionResult> {
  const parsed = LayoutSchema.safeParse(layout);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // Unknown widget types raus
  const cleaned: DashboardLayout = {
    version: 2,
    widgets: parsed.data.widgets.filter((w) => w.type in WIDGET_BY_TYPE) as DashboardLayout['widgets'],
  };

  return withStaff(
    async (tx, { staffId }) => {
      await tx.staffUser.update({
        where: { id: staffId },
        data: { dashboardLayout: cleaned as unknown as Prisma.InputJsonValue },
      });
    },
    { revalidate: '/staff/dashboard' },
  );
}

export async function resetDashboardLayoutAction(): Promise<ActionResult> {
  return withStaff(
    async (tx, { staffId }) => {
      await tx.staffUser.update({
        where: { id: staffId },
        data: { dashboardLayout: Prisma.JsonNull },
      });
    },
    { revalidate: '/staff/dashboard' },
  );
}
