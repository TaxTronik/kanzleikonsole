import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { PlanEditor } from '@/app/portal/(protected)/bwa/plan/[id]/editor';
import { ActorBadge } from '@/app/portal/(protected)/bwa/plan/plan-comparison';
import { updateStaffPlanAction, deleteStaffPlanAction } from '../actions';

const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export default async function StaffPlanDetailPage({
  params,
}: {
  params: Promise<{ id: string; planId: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId, planId } = await params;
  const { tenantId, staffId } = session.user;

  const plan = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const p = await tx.bwaPlan.findFirst({
        where: { id: planId, clientId },
        include: {
          lines: true,
          basePeriod: { select: { id: true, periodKey: true } },
        },
      });
      if (!p) return null;
      // Created/Updated-By Namen auflösen
      const [createdByContact, updatedByContact, createdByStaff, updatedByStaff] = await Promise.all([
        p.createdByType === 'CLIENT_CONTACT'
          ? tx.clientContact.findUnique({ where: { id: p.createdBy }, select: { fullName: true } })
          : Promise.resolve(null),
        p.updatedByType === 'CLIENT_CONTACT' && p.updatedBy
          ? tx.clientContact.findUnique({ where: { id: p.updatedBy }, select: { fullName: true } })
          : Promise.resolve(null),
        p.createdByType === 'STAFF'
          ? tx.staffUser.findUnique({ where: { id: p.createdBy }, select: { fullName: true } })
          : Promise.resolve(null),
        p.updatedByType === 'STAFF' && p.updatedBy
          ? tx.staffUser.findUnique({ where: { id: p.updatedBy }, select: { fullName: true } })
          : Promise.resolve(null),
      ]);
      return {
        ...p,
        createdByName: createdByContact?.fullName ?? createdByStaff?.fullName ?? '—',
        updatedByName: updatedByContact?.fullName ?? updatedByStaff?.fullName ?? '—',
      };
    },
  );
  if (!plan) notFound();

  const actorInfo = (
    <div className="card p-4 flex flex-wrap items-center gap-3">
      <ActorBadge
        createdByType={plan.createdByType as 'STAFF' | 'CLIENT_CONTACT'}
        updatedByType={
          plan.updatedByType === 'STAFF'
            ? 'STAFF'
            : plan.updatedByType === 'CLIENT_CONTACT'
            ? 'CLIENT_CONTACT'
            : null
        }
      />
      <div className="text-xs text-gray-600">
        Erstellt von <strong>{plan.createdByName}</strong> am {dateFmt.format(plan.createdAt)}
        {plan.updatedBy && plan.updatedBy !== plan.createdBy && (
          <>
            {' · '}
            zuletzt geändert von <strong>{plan.updatedByName}</strong> am {dateFmt.format(plan.updatedAt)}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href={`/staff/clients/${clientId}/bwa/plans`}
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
        backHref={`/staff/clients/${clientId}/bwa/plans`}
        onUpdate={updateStaffPlanAction.bind(null, clientId)}
        onDelete={deleteStaffPlanAction.bind(null, clientId)}
        actorInfo={actorInfo}
      />
    </div>
  );
}
