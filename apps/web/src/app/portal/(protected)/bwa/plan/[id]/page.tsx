import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { PlanEditor } from './editor';
import { updatePlanAction, deletePlanAction } from '../actions';

export default async function PortalPlanDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { id } = await params;
  const { tenantId, contactId, clientId } = session.user;

  const plan = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.bwaPlan.findFirst({
        where: { id, clientId },
        include: {
          lines: true,
          basePeriod: { select: { id: true, periodKey: true } },
        },
      }),
  );
  if (!plan) notFound();

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href="/portal/bwa"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-3"
      >
        <ArrowLeft className="h-3 w-3" />
        Auswertungen
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">{plan.name}</h1>
      <p className="text-gray-500 text-sm mb-6">
        Planjahr {plan.year}
        {plan.basePeriod && ` · Basis: ${plan.basePeriod.periodKey}`}
        {' · '}
        {plan.status === 'FINAL' ? 'Status: Final' : 'Status: Entwurf'}
      </p>

      <PlanEditor
        planId={plan.id}
        initial={{
          name: plan.name,
          notes: plan.notes ?? '',
          status: plan.status === 'FINAL' ? 'FINAL' : 'DRAFT',
          lines: plan.lines.map((l) => ({
            axis: l.axis as 'REVENUE' | 'PERSONNEL' | 'OTHER_COSTS' | 'DEPRECIATION' | 'MATERIAL' | 'OTHER_INCOME' | 'TAXES',
            amount: Number(l.amount.toString()),
            note: l.note ?? '',
          })),
        }}
        backHref="/portal/bwa"
        onUpdate={updatePlanAction}
        onDelete={deletePlanAction}
      />
    </div>
  );
}
