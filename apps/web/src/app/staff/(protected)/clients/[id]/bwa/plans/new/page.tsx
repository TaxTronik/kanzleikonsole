import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { computeBwaKpis } from '@/server/bwa/addison-parser';
import { PlanWizard } from '@/app/portal/(protected)/bwa/plan/plan-wizard';
import { createStaffPlanAction } from '../actions';

export default async function StaffNewPlanPage({
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
      const periods = await tx.bwaPeriod.findMany({
        where: { clientId },
        orderBy: [{ periodType: 'asc' }, { fromDate: 'desc' }],
        include: { positions: { select: { number: true, amount: true } } },
      });
      return { client, periods };
    },
  );
  if (!data) notFound();
  const { client, periods } = data;

  const bases = periods.map((p) => {
    const map = new Map<number, number>();
    for (const pos of p.positions) map.set(pos.number, Number(pos.amount.toString()));
    const k = computeBwaKpis(p.positions);
    return {
      id: p.id,
      periodKey: p.periodKey,
      label: p.periodKey,
      periodType: p.periodType as 'YEAR' | 'QUARTER' | 'MONTH',
      revenue: k.revenue,
      costs: k.costs,
      result: k.result,
      personnelCost: k.personnelCost,
      material: map.get(3010) ?? null,
      depreciation: map.get(3100) ?? null,
      otherIncome: map.get(1010) ?? null,
    };
  });

  const currentYear = new Date().getUTCFullYear();

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href={`/staff/clients/${clientId}/bwa/plans`}
        className="back-link mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Auswertungen
      </Link>
      <h1 className="text-2xl font-bold text-primary mb-1">Neue Planung anlegen</h1>
      <p className="text-muted text-sm mb-6">
        Für {client.name}. Die Planung wird als „Von der Kanzlei erstellt" markiert.
      </p>
      <PlanWizard
        bases={bases}
        defaultYear={currentYear + 1}
        onCreate={createStaffPlanAction.bind(null, clientId)}
      />
    </div>
  );
}
