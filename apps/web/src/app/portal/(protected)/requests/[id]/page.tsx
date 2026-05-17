import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ClipboardList, CheckCircle2 } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { PortalResponseForm } from './response-form';

const statusLabels: Record<string, string> = {
  OPEN: 'Offen',
  IN_PROGRESS: 'In Bearbeitung',
  RESPONDED: 'Beantwortet',
  CLOSED: 'Geschlossen',
  CANCELLED: 'Abgebrochen',
};

export default async function PortalRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { id } = await params;
  const { tenantId, contactId, clientId } = session.user;

  const reqRow = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.request.findFirst({
        where: { id, clientId },
        include: {
          responses: {
            orderBy: { createdAt: 'asc' },
            include: { document: true },
          },
          formSubmission: {
            select: { id: true, name: true, status: true, submittedAt: true },
          },
        },
      }),
  );

  if (!reqRow) notFound();

  const isOpen = reqRow.status !== 'CLOSED' && reqRow.status !== 'CANCELLED';

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/portal/requests" className="text-gray-400 hover:text-gray-600 mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">{reqRow.title}</h1>
            <span className={
              reqRow.status === 'CLOSED' ? 'badge-gray'
              : reqRow.status === 'RESPONDED' ? 'badge-green'
              : 'badge-yellow'
            }>
              {statusLabels[reqRow.status]}
            </span>
          </div>
          {reqRow.dueAt && (
            <p className="text-sm text-gray-500">
              fällig {new Intl.DateTimeFormat('de-DE').format(reqRow.dueAt)}
            </p>
          )}
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
          Was wird benötigt?
        </h2>
        <p className="text-sm text-gray-800 whitespace-pre-wrap">{reqRow.description}</p>
      </div>

      {reqRow.formSubmission && (
        <div className="card p-6 mb-6 border-brand-200 bg-brand-50/30">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              {reqRow.formSubmission.submittedAt ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              ) : (
                <ClipboardList className="h-5 w-5 text-brand-600 mt-0.5 shrink-0" />
              )}
              <div>
                <h2 className="text-sm font-medium text-gray-900">
                  Formular zur Anforderung
                </h2>
                <p className="text-sm text-gray-700 mt-0.5">
                  {reqRow.formSubmission.name}
                </p>
                {reqRow.formSubmission.submittedAt ? (
                  <p className="text-xs text-emerald-700 mt-1">
                    Abgesendet am {new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(reqRow.formSubmission.submittedAt)}
                  </p>
                ) : (
                  <p className="text-xs text-brand-700 mt-1">
                    Bitte ausfüllen und absenden.
                  </p>
                )}
              </div>
            </div>
            <Link
              href={`/portal/forms/${reqRow.formSubmission.id}`}
              className={reqRow.formSubmission.submittedAt ? 'btn-secondary text-sm' : 'btn-primary text-sm'}
            >
              {reqRow.formSubmission.submittedAt ? 'Ansehen' : 'Formular öffnen'}
            </Link>
          </div>
        </div>
      )}

      {reqRow.responses.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-sm font-medium text-gray-900">Verlauf</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {reqRow.responses.map((r) => (
              <div key={r.id} className="px-6 py-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={r.authorType === 'STAFF' ? 'badge-gray' : 'badge-green'}>
                    {r.authorType === 'STAFF' ? 'Kanzlei' : 'Sie'}
                  </span>
                  <span className="text-xs text-gray-400">
                    {new Intl.DateTimeFormat('de-DE', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }).format(r.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{r.message}</p>
                {r.document && (
                  <p className="mt-2 text-xs text-gray-500">
                    Beigefügtes Dokument: {r.document.title}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {isOpen ? (
        <div className="card p-6">
          <h2 className="text-sm font-medium text-gray-900 mb-3">Antworten</h2>
          <PortalResponseForm requestId={reqRow.id} />
        </div>
      ) : (
        <div className="rounded-md bg-gray-50 p-4 text-sm text-gray-600 text-center">
          Diese Anforderung ist abgeschlossen.
        </div>
      )}
    </div>
  );
}
