import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { BwaDashboard } from '@/components/bwa/bwa-dashboard';

export default async function StaffClientBwaDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true },
      });
      if (!client) return null;
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
      return { client, periods, plans };
    },
  );

  if (!data) notFound();
  const { client, periods, plans } = data;

  return (
    <div className="p-8 max-w-6xl">
      <Link
        href={`/staff/clients/${clientId}/bwa`}
        className="inline-flex items-center gap-1 text-sm text-muted hover:text-primary mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        BWA-Import
      </Link>
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
          createdByType: (p.createdByType === 'STAFF' ? 'STAFF' : 'CLIENT_CONTACT') as 'STAFF' | 'CLIENT_CONTACT',
          updatedByType:
            p.updatedByType === 'STAFF'
              ? 'STAFF'
              : p.updatedByType === 'CLIENT_CONTACT'
              ? 'CLIENT_CONTACT'
              : null,
          lines: p.lines.map((l) => ({ axis: l.axis, amount: l.amount })),
        }))}
        linkPrefix={`/staff/clients/${clientId}/bwa/plans`}
        newPlanHref={`/staff/clients/${clientId}/bwa/plans/new`}
        title={`Auswertungen: ${client.name}`}
        subtitle="Sicht der Kanzlei — entspricht der Portal-Sicht des Mandanten. Pläne sind nach Herkunft markiert."
      />
    </div>
  );
}
