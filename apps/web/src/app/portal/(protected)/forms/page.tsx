// =============================================================================
// /portal/forms — Mandant sieht offene Formulare
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateNumeric } from '@/lib/fmt';
import { FORM_SUBMISSION_STATUS_LABELS } from '@/lib/domain-labels';

const PORTAL_FORM_STATUS_LABELS: Readonly<Record<string, string>> = {
  ...FORM_SUBMISSION_STATUS_LABELS,
  PENDING: 'Offen',
  SUBMITTED: 'Übermittelt',
};

export default async function PortalFormsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId, clientId } = session.user;

  const submissions = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.formSubmission.findMany({
        where: { clientId },
        include: {
          requests: {
            where: { tenantId, clientId },
            select: { id: true, status: true },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      }),
  );

  const requestClosed = (submission: (typeof submissions)[number]) => {
    const requests = submission.requestId
      ? submission.requests.filter((candidate) => candidate.id === submission.requestId)
      : submission.requests;
    if (submission.requestId && requests.length !== 1) return true;
    return requests.some((request) => !['OPEN', 'IN_PROGRESS'].includes(request.status));
  };
  const open = submissions.filter(
    (s) => (s.status === 'PENDING' || s.status === 'DRAFT') && !requestClosed(s),
  );
  const done = submissions.filter(
    (s) => s.status === 'SUBMITTED' || s.status === 'REVIEWED' || requestClosed(s),
  );

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="page-title">
        <ClipboardList className="h-6 w-6 text-brand-600" />
        Formulare
      </h1>
      <p className="text-muted text-sm mb-6">
        Anfragen Ihrer Steuerkanzlei. Bitte ausfüllen und absenden.
      </p>

      {open.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-primary mb-3">
            Offene Formulare ({open.length})
          </h2>
          <ul className="card divide-y divide-border-subtle">
            {open.map((s) => (
              <li key={s.id} className="px-6 py-4 flex items-center justify-between">
                <div>
                  <Link
                    href={`/portal/forms/${s.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {s.name}
                  </Link>
                  <p className="text-xs text-muted">
                    Versendet {fmtDateNumeric(s.createdAt)}
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
          <p className="text-sm text-disabled">Aktuell keine offenen Formulare.</p>
        </div>
      ) : null}

      {done.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-secondary">
            {done.length} abgeschlossene{done.length === 1 ? 's' : ''} Formular
            {done.length === 1 ? '' : 'e'}
          </summary>
          <ul className="card divide-y divide-border-subtle mt-3">
            {done.map((s) => (
              <li key={s.id} className="px-6 py-3 flex items-center justify-between text-sm">
                <Link href={`/portal/forms/${s.id}`} className="text-secondary hover:underline">
                  {s.name}
                </Link>
                <span className="text-xs text-muted">
                  {requestClosed(s) && (s.status === 'PENDING' || s.status === 'DRAFT')
                    ? 'Geschlossen'
                    : PORTAL_FORM_STATUS_LABELS[s.status]}
                  {s.submittedAt && ` · ${fmtDateNumeric(s.submittedAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
