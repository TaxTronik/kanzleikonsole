import { redirect } from 'next/navigation';
import { Building2, Trash2 } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { NewProviderForm } from './new-form';
import { deleteServiceProviderAction } from './actions';
import { fmtDateShort } from '@/lib/fmt';

export default async function ServiceProvidersPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;

  const providers = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.serviceProvider.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
  );

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Dienstleisterverzeichnis</h1>
        <p className="text-muted text-sm">
          § 11 GwG · DSGVO Art. 28 — Dienstleister mit Zugriff auf personenbezogene Daten.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          {providers.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <Building2 className="h-12 w-12 text-disabled mx-auto mb-3" />
              <p className="text-sm text-disabled">Noch keine Dienstleister erfasst.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {providers.map((p) => (
                <li key={p.id} className="px-6 py-4 flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-primary">{p.name}</span>
                      <span className="badge-gray">{p.category}</span>
                      {p.hasDataAccess && <span className="badge-yellow">Datenzugriff</span>}
                    </div>
                    <p className="text-xs text-muted">
                      {p.contactEmail ?? 'kein Kontakt'}
                      {p.contractFromDate
                        ? ` · Vertrag seit ${fmtDateShort(p.contractFromDate)}`
                        : ''}
                      {p.contractToDate
                        ? ` · bis ${fmtDateShort(p.contractToDate)}`
                        : ''}
                    </p>
                    {p.notes && (
                      <p className="text-xs text-secondary mt-2 whitespace-pre-wrap">{p.notes}</p>
                    )}
                  </div>
                  <form action={deleteServiceProviderAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button
                      type="submit"
                      className="text-disabled hover:text-red-600 p-2"
                      title="Löschen"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-6 h-fit">
          <h2 className="text-sm font-medium text-primary mb-4">Neuer Dienstleister</h2>
          <NewProviderForm />
        </div>
      </div>
    </div>
  );
}
