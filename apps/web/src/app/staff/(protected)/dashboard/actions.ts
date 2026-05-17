'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { WIDGET_BY_TYPE, type DashboardLayout } from '@/server/dashboard/widgets';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = LayoutSchema.safeParse(layout);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // Unknown widget types raus
  const cleaned: DashboardLayout = {
    version: 2,
    widgets: parsed.data.widgets.filter((w) => w.type in WIDGET_BY_TYPE) as DashboardLayout['widgets'],
  };

  const { tenantId, staffId } = session.user;
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffUser.update({
        where: { id: staffId },
        data: { dashboardLayout: cleaned as unknown as Prisma.InputJsonValue },
      }),
  );

  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function resetDashboardLayoutAction(): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const { tenantId, staffId } = session.user;
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.staffUser.update({
        where: { id: staffId },
        data: { dashboardLayout: Prisma.JsonNull },
      }),
  );
  revalidatePath('/staff/dashboard');
  return { ok: true };
}
