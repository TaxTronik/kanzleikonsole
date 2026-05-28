import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { redirect } from 'next/navigation';

import { DEFAULT_LAYOUT, parseLayout } from '@/server/dashboard/widgets';
import { renderWidget } from './widgets';
import { DashboardGrid } from './dashboard-grid';

export default async function DashboardPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;
  const isAdmin = isStaffAdmin(session);

  // Layout laden + alle Widgets in einer Tx rendern
  const { layout, rendered } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const staff = await tx.staffUser.findUnique({
        where: { id: staffId },
        select: { dashboardLayout: true },
      });
      const layout = staff?.dashboardLayout ? parseLayout(staff.dashboardLayout) : DEFAULT_LAYOUT;
      const rendered = await Promise.all(
        layout.widgets.map(async (w) => ({
          widget: w,
          node: await renderWidget(w.type, { tx, staffId, isAdmin }),
        })),
      );
      return { layout, rendered };
    },
  );

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
