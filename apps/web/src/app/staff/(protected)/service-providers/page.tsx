import { redirect } from 'next/navigation';
import { Building2, Trash2 } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { NewProviderForm } from './new-form';
import { deleteServiceProviderAction } from './actions';

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
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Dienstleisterverzeichnis</h1>
        <p className="text-gray-500 text-sm">
          § 11 GwG · DSGVO Art. 28 — Dienstleister mit Zugriff auf personenbezogene Daten.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          {providers.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <Building2 className="h-12 w-12 text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-400">Noch keine Dienstleister erfasst.</p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {providers.map((p) => (
                <li key={p.id} className="px-6 py-4 flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      <span className="badge-gray">{p.category}</span>
                      {p.hasDataAccess && <span className="badge-yellow">Datenzugriff</span>}
                    </div>
                    <p className="text-xs text-gray-500">
                      {p.contactEmail ?? 'kein Kontakt'}
                      {p.contractFromDate
                        ? ` · Vertrag seit ${new Intl.DateTimeFormat('de-DE').format(p.contractFromDate)}`
                        : ''}
                      {p.contractToDate
                        ? ` · bis ${new Intl.DateTimeFormat('de-DE').format(p.contractToDate)}`
                        : ''}
                    </p>
                    {p.notes && (
                      <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap">{p.notes}</p>
                    )}
                  </div>
                  <form action={deleteServiceProviderAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button
                      type="submit"
                      className="text-gray-400 hover:text-red-600 p-2"
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
          <h2 className="text-sm font-medium text-gray-900 mb-4">Neuer Dienstleister</h2>
          <NewProviderForm />
        </div>
      </div>
    </div>
  );
}
