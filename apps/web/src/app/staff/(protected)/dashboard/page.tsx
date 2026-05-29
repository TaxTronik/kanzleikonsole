import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { redirect } from 'next/navigation';

import { DEFAULT_LAYOUT, parseLayout } from '@/server/dashboard/widgets';
import { renderWidget } from './widgets';
import { DashboardGrid } from './dashboard-grid';

// Wie viele Widgets gleichzeitig gerendert werden (= gleichzeitige DB-
// Connections). Begrenzt, damit der Connection-Pool bei vielen/parallelen
// Dashboard-Aufrufen nicht überrannt wird.
const WIDGET_CONCURRENCY = 4;

/** Reihenfolge-erhaltendes map mit Parallelitäts-Limit. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async function DashboardPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const isAdmin = isStaffAdmin(session);
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  // 1. Layout laden (eine kurze Tx).
  const layout = await withTenantContext(ctx, async (tx) => {
    const staff = await tx.staffUser.findUnique({
      where: { id: staffId },
      select: { dashboardLayout: true },
    });
    return staff?.dashboardLayout ? parseLayout(staff.dashboardLayout) : DEFAULT_LAYOUT;
  });

  // 2. Widgets PARALLEL rendern — jedes in eigener Tx (eigene Connection).
  // serializeTx serialisiert Queries innerhalb EINER Tx; mit je eigener Tx
  // laufen die Widgets echt gleichzeitig → Dashboard-Zeit ≈ langsamstes
  // Widget statt Summe aller. Concurrency-Cap schützt den Pool.
  const rendered = await mapWithConcurrency(layout.widgets, WIDGET_CONCURRENCY, async (w) => ({
    widget: w,
    node: await withTenantContext(ctx, (tx) => renderWidget(w.type, { tx, staffId, isAdmin })),
  }));

  return (
    <div className="p-8">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-primary">Dashboard</h1>
        <p className="text-muted mt-1">Willkommen, {session.user.fullName}</p>
      </div>

      <DashboardGrid initialLayout={layout} initialRendered={rendered} />
    </div>
  );
}
