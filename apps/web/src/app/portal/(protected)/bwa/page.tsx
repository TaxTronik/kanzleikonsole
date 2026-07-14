import { redirect } from 'next/navigation';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { BwaDashboard } from '@/components/bwa/bwa-dashboard';

export default async function PortalBwaPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const features = await readPortalFeatures({
    tenantId,
    actorId: contactId,
    actorType: 'CLIENT_CONTACT',
  });
  if (!features.bwaView) redirect('/portal/dashboard');

  const { periods, plans } = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const [periods, plans] = await Promise.all([
        tx.bwaPeriod.findMany({
          where: { clientId },
          orderBy: [{ periodType: 'asc' }, { fromDate: 'desc' }],
          include: { positions: true },
        }),
        tx.bwaPlan.findMany({
          where: { clientId },
          orderBy: [{ year: 'desc' }, { updatedAt: 'desc' }],
          include: { lines: true },
        }),
      ]);
      return { periods, plans };
    },
  );

  return (
    <div className="p-8 max-w-6xl">
      <BwaDashboard
        periods={periods.map((p) => ({
          id: p.id,
          periodKey: p.periodKey,
          periodType: p.periodType as 'YEAR' | 'QUARTER' | 'MONTH',
          fromDate: p.fromDate,
          toDate: p.toDate,
          positions: p.positions.map((pos) => ({ number: pos.number, amount: pos.amount })),
        }))}
        plans={plans.map((p) => ({
          id: p.id,
          name: p.name,
          year: p.year,
          status: p.status,
          updatedAt: p.updatedAt,
          createdByType: (p.createdByType === 'STAFF' ? 'STAFF' : 'CLIENT_CONTACT') as
            | 'STAFF'
            | 'CLIENT_CONTACT',
          updatedByType:
            p.updatedByType === 'STAFF'
              ? 'STAFF'
              : p.updatedByType === 'CLIENT_CONTACT'
                ? 'CLIENT_CONTACT'
                : null,
          lines: p.lines.map((l) => ({ axis: l.axis, amount: l.amount })),
        }))}
        linkPrefix="/portal/bwa/plan"
        newPlanHref={features.bwaPlanning ? '/portal/bwa/plan/new' : null}
        subtitle="Kennzahlen aus den von Ihrer Kanzlei eingespielten BWAs."
      />
    </div>
  );
}
