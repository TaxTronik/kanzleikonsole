// =============================================================================
// /portal/forms — Mandant sieht offene Formulare
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Offen',
  DRAFT: 'Entwurf',
  SUBMITTED: 'Übermittelt',
  REVIEWED: 'Geprüft',
};

const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short' });

export default async function PortalFormsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId, clientId } = session.user;

  const submissions = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.formSubmission.findMany({
        where: { clientId },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      }),
  );

  const open = submissions.filter((s) => s.status === 'PENDING' || s.status === 'DRAFT');
  const done = submissions.filter((s) => s.status === 'SUBMITTED' || s.status === 'REVIEWED');

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1 flex items-center gap-2">
        <ClipboardList className="h-6 w-6 text-brand-600" />
        Formulare
      </h1>
      <p className="text-gray-500 text-sm mb-6">
        Anfragen Ihrer Steuerkanzlei. Bitte ausfüllen und absenden.
      </p>

      {open.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Offene Formulare ({open.length})</h2>
          <ul className="card divide-y divide-gray-100">
            {open.map((s) => (
              <li key={s.id} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <Link href={`/portal/forms/${s.id}`} className="font-medium text-gray-900 hover:underline">
                    {s.name}
                  </Link>
                  <p className="text-xs text-gray-500">
                    Versendet {dateFmt.format(s.createdAt)}
                    {s.status === 'DRAFT' && ' · Entwurf gespeichert'}
                  </p>
                </div>
                <Link href={`/portal/forms/${s.id}`} className="btn-primary text-xs">
                  Ausfüllen
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length === 0 && open.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-gray-400">Aktuell keine offenen Formulare.</p>
        </div>
      ) : null}

      {done.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-gray-700">
            {done.length} abgeschlossene{done.length === 1 ? 's' : ''} Formular{done.length === 1 ? '' : 'e'}
          </summary>
          <ul className="card divide-y divide-gray-100 mt-3">
            {done.map((s) => (
              <li key={s.id} className="px-6 py-3 flex items-center justify-between text-sm">
                <Link href={`/portal/forms/${s.id}`} className="text-gray-700 hover:underline">
                  {s.name}
                </Link>
                <span className="text-xs text-gray-500">
                  {STATUS_LABELS[s.status]}
                  {s.submittedAt && ` · ${dateFmt.format(s.submittedAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
