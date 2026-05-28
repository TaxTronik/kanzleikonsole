import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { computeBwaKpis } from '@/server/bwa/addison-parser';
import { PlanWizard } from '../plan-wizard';
import { createPlanAction } from '../actions';

export default async function NewPlanPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId, clientId } = session.user;
  const features = await readPortalFeatures({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' });
  if (!features.bwaPlanning) redirect('/portal/bwa');

  const periods = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.bwaPeriod.findMany({
        where: { clientId },
        orderBy: [{ periodType: 'asc' }, { fromDate: 'desc' }],
        include: { positions: { select: { number: true, amount: true } } },
      }),
  );

  // Aufbereiten: pro Periode KPIs + Position-Maps für Achsen-Vorbelegung
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
      // Einzelne Positionen für Plan-Achsen-Vorbelegung
      material: map.get(3010) ?? null,
      depreciation: map.get(3100) ?? null,
      otherIncome: map.get(1010) ?? null,
    };
  });

  const currentYear = new Date().getUTCFullYear();

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href="/portal/bwa"
        className="back-link mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Auswertungen
      </Link>
      <h1 className="text-2xl font-bold text-primary mb-1">Neue Planrechnung</h1>
      <p className="text-muted text-sm mb-6">
        Drei Schritte: Basis wählen — Achsen anpassen — speichern.
      </p>
      <PlanWizard
        bases={bases}
        defaultYear={currentYear + 1}
        onCreate={createPlanAction}
      />
    </div>
  );
}
