import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin, inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';

import Link from 'next/link';
import { ListChecks, ArrowRight } from 'lucide-react';

import {
  DEFAULT_LAYOUT,
  enabledDashboardWidgetTypes,
  filterDashboardLayoutByModules,
  parseLayout,
} from '@/server/dashboard/widgets';
import { getSetupStatus, type SetupStatus } from '@/server/setup/status';
import { readModules } from '@/server/settings/modules';
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
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const isAdmin = isStaffAdmin(session);
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  // 1. Layout laden (eine kurze Tx) + EIN denied-Set für alle Widgets
  // (Zugriffsmodell: vertraulich-Flag / RESTRICTED).
  const [{ storedLayout, deniedClientIds }, modules] = await Promise.all([
    withTenantContext(ctx, async (tx) => {
      const [staff, deniedClientIds] = await Promise.all([
        tx.staffUser.findUnique({
          where: { id: staffId },
          select: { dashboardLayout: true },
        }),
        inaccessibleClientIdsFor(tx, session),
      ]);
      return {
        storedLayout: staff?.dashboardLayout ? parseLayout(staff.dashboardLayout) : DEFAULT_LAYOUT,
        deniedClientIds,
      };
    }),
    readModules(ctx),
  ]);
  const layout = filterDashboardLayoutByModules(storedLayout, modules);

  // 2. Widgets PARALLEL rendern — jedes in eigener Tx (eigene Connection).
  // serializeTx serialisiert Queries innerhalb EINER Tx; mit je eigener Tx
  // laufen die Widgets echt gleichzeitig → Dashboard-Zeit ≈ langsamstes
  // Widget statt Summe aller. Concurrency-Cap schützt den Pool.
  const rendered = await mapWithConcurrency(layout.widgets, WIDGET_CONCURRENCY, async (w) => ({
    widget: w,
    node: await withTenantContext(ctx, (tx) =>
      renderWidget(w.type, { tx, staffId, isAdmin, deniedClientIds, modules }),
    ),
  }));

  // Onboarding: solange die Inbetriebnahme-Checkliste offen ist, sehen Admins
  // sie direkt nach dem Login — nicht erst beim Besuch der Administration.
  // Erledigt sich von selbst oder kann vom Admin bewusst ausgeblendet werden.
  const setup: SetupStatus | null = isAdmin ? await getSetupStatus(ctx) : null;

  return (
    <div className="p-8">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-primary">Dashboard</h1>
        <p className="text-muted mt-1">Willkommen, {session.user.fullName}</p>
      </div>

      {setup && !setup.allDone && !setup.dismissed && (
        <Link
          href="/staff/admin"
          className="card p-4 mb-4 flex items-center gap-3 border-l-4 border-l-yellow-500 dark:border-l-yellow-400 hover:bg-gray-50 group"
        >
          <ListChecks className="h-5 w-5 text-yellow-600 dark:text-yellow-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-primary">
              Erste Schritte zur Inbetriebnahme — {setup.doneCount} von {setup.totalCount} erledigt
            </p>
            <p className="text-xs text-muted truncate">
              Offen:{' '}
              {setup.items
                .filter((i) => !i.done)
                .map((i) => i.label)
                .join(' · ')}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 text-disabled group-hover:text-muted shrink-0" />
        </Link>
      )}

      <DashboardGrid
        initialLayout={layout}
        renderedWidgets={rendered}
        enabledWidgetTypes={enabledDashboardWidgetTypes(modules)}
      />
    </div>
  );
}
