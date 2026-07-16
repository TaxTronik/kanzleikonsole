import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { MachineEditor } from './editor';
import { MachineMetaForm } from './meta-form';

export default async function StateMachineEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireStaffPage({ admin: true });
  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const machine = await tx.stateMachine.findUnique({
        where: { id },
        include: {
          states: { orderBy: { position: 'asc' } },
          transitions: true,
        },
      });
      if (!machine) return null;
      return machine;
    },
  );
  if (!data) notFound();

  const statesByKey = new Map(data.states.map((s) => [s.id, s.key]));
  const transitions = data.transitions.map((t) => ({
    fromKey: statesByKey.get(t.fromStateId)!,
    toKey: statesByKey.get(t.toStateId)!,
    label: t.label,
    conditionNote: t.conditionNote,
  }));

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/staff/admin/state-machines" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" />
        Status-Maschinen
      </Link>
      <h1 className="text-2xl font-bold text-primary mb-1">{data.name}</h1>
      <p className="text-muted text-sm mb-6">
        <code className="font-mono text-xs">{data.slug}</code>
        {data.appliesTo ? ` · gilt für ${data.appliesTo}` : ''}
      </p>

      <MachineMetaForm
        machineId={data.id}
        initial={{
          name: data.name,
          description: data.description ?? '',
          appliesTo: data.appliesTo ?? '',
          active: data.active,
        }}
      />

      <MachineEditor
        machineId={data.id}
        initialStates={data.states.map((s) => ({
          id: s.id,
          key: s.key,
          label: s.label,
          color: s.color ?? '',
          isInitial: s.isInitial,
          isTerminal: s.isTerminal,
        }))}
        initialTransitions={transitions.map((t) => ({
          fromKey: t.fromKey,
          toKey: t.toKey,
          label: t.label,
          conditionNote: t.conditionNote ?? '',
        }))}
      />
    </div>
  );
}
