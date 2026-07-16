import Link from 'next/link';
import { ArrowLeft, Plus, GitBranch } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { NewMachineForm } from './new-form';

export default async function StateMachinesIndexPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;

  const machines = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.stateMachine.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          _count: { select: { states: true, transitions: true } },
        },
      }),
  );

  return (
    <div className="p-8 max-w-4xl">
      <Link href="/staff/admin" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" />
        Administration
      </Link>
      <h1 className="text-2xl font-bold text-primary mb-1">Status-Maschinen</h1>
      <p className="text-muted text-sm mb-6">
        Eigene Zustandsautomaten — z. B. „Mandanten-Onboarding-Phase",
        „Steuererklärungs-Bearbeitungsstand". Wird in einer späteren Iteration an Ressourcen
        gebunden.
      </p>

      {machines.length > 0 ? (
        <ul className="space-y-2 mb-6">
          {machines.map((m) => (
            <li key={m.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-brand-600" />
                    <Link
                      href={`/staff/admin/state-machines/${m.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {m.name}
                    </Link>
                    <code className="text-xs text-muted font-mono">{m.slug}</code>
                    {!m.active && <span className="badge-yellow">deaktiviert</span>}
                  </div>
                  {m.description && <p className="text-xs text-muted mt-1">{m.description}</p>}
                  <p className="text-xs text-disabled mt-1">
                    {m._count.states} Zustände, {m._count.transitions} Übergänge
                    {m.appliesTo ? ` · gilt für ${m.appliesTo}` : ''}
                  </p>
                </div>
                <Link
                  href={`/staff/admin/state-machines/${m.id}`}
                  className="btn-secondary text-xs py-1"
                >
                  Bearbeiten
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="card p-8 text-center text-sm text-muted mb-6">
          Noch keine Status-Maschinen.
        </div>
      )}

      <div className="card p-6 border-brand-300">
        <h2 className="text-sm font-medium text-primary mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Neue Status-Maschine
        </h2>
        <NewMachineForm />
      </div>
    </div>
  );
}
