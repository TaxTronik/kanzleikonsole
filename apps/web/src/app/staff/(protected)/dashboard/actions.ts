'use server';

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { Prisma as PrismaRuntime } from '@taxtronik/db/prisma-client';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import type { ReactNode } from 'react';
import {
  WIDGET_BY_TYPE,
  isDashboardWidgetEnabled,
  type DashboardLayout,
  type LayoutWidget,
} from '@/server/dashboard/widgets';
import {
  ActionError,
  withStaff,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { inaccessibleClientIdsFor, isStaffAdmin } from '@/server/auth/rbac';
import { renderWidget } from './widgets';

export type ActionResult = BaseActionResult;

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

function cleanLayout(layout: DashboardLayout): DashboardLayout | null {
  const parsed = LayoutSchema.safeParse(layout);
  if (!parsed.success) return null;
  return {
    version: 2,
    widgets: parsed.data.widgets.filter(
      (widget) => widget.type in WIDGET_BY_TYPE,
    ) as DashboardLayout['widgets'],
  };
}

export async function saveDashboardLayoutAction(layout: DashboardLayout): Promise<ActionResult> {
  const cleaned = cleanLayout(layout);
  if (!cleaned) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(async (tx, { staffId }) => {
    await tx.staffUser.update({
      where: { id: staffId },
      data: { dashboardLayout: cleaned as unknown as Prisma.InputJsonValue },
    });
  });
}

export type AddDashboardWidgetResult = ActionResult & {
  rendered?: { widget: LayoutWidget; node: ReactNode };
};

/**
 * Speichert das Layout und rendert ausschließlich den neu hinzugefügten Slot.
 * Ein kompletter RSC-Refresh würde alle vorhandenen Widget-Abfragen erneut
 * ausführen und machte einen einzelnen Klick mit wachsendem Dashboard langsamer.
 */
export async function addDashboardWidgetAction(
  layout: DashboardLayout,
  widgetId: string,
): Promise<AddDashboardWidgetResult> {
  const cleaned = cleanLayout(layout);
  if (!cleaned) return { ok: false, error: 'Validierungsfehler.' };
  const widget = cleaned.widgets.find((entry) => entry.id === widgetId);
  if (!widget) return { ok: false, error: 'Widget nicht gefunden.' };

  return withStaff(async (tx, { tenantId, staffId, session }) => {
    const modules = await readBooleanTenantModules(tx, tenantId);
    if (!isDashboardWidgetEnabled(widget.type, modules)) {
      throw new ActionError('Dieses Dashboard-Widget ist für die deaktivierte Funktion gesperrt.');
    }
    const deniedClientIds = await inaccessibleClientIdsFor(tx, session);
    await tx.staffUser.update({
      where: { id: staffId },
      data: { dashboardLayout: cleaned as unknown as Prisma.InputJsonValue },
    });
    const node = await renderWidget(widget.type, {
      tx,
      staffId,
      isAdmin: isStaffAdmin(session),
      deniedClientIds,
      modules,
    });
    return { rendered: { widget, node } };
  });
}

export async function resetDashboardLayoutAction(): Promise<ActionResult> {
  return withStaff(
    async (tx, { staffId }) => {
      await tx.staffUser.update({
        where: { id: staffId },
        data: { dashboardLayout: PrismaRuntime.JsonNull },
      });
    },
    { revalidate: '/staff/dashboard' },
  );
}
