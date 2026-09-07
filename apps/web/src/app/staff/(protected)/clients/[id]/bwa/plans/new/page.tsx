import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { computeBwaPlanBasis } from '@/server/bwa/plan-basis';
import { PlanWizard } from '@/app/portal/(protected)/bwa/plan/plan-wizard';
import { createStaffPlanAction } from '../actions';

export default async function StaffNewPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStaffPage();
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

  const bases = periods.map((p) => ({
    id: p.id,
    periodKey: p.periodKey,
    label: p.periodKey,
    periodType: p.periodType,
    ...computeBwaPlanBasis(p.positions, p.source),
  }));

  const currentYear = new Date().getUTCFullYear();

  return (
    <div className="p-8 max-w-3xl">
      <Link href={`/staff/clients/${clientId}/bwa/plans`} className="back-link mb-3">
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
