import { requireStaffPage } from '@/server/auth/staff-page';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { closeRequestAction, reopenRequestAction } from '../../clients/[id]/requests/actions';
import { StaffResponseForm } from './staff-response-form';
import { InternalCommentForm } from './internal-comment-form';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';

const statusLabels: Record<string, string> = {
  OPEN: 'Offen',
  IN_PROGRESS: 'In Bearbeitung',
  RESPONDED: 'Beantwortet',
  CLOSED: 'Geschlossen',
  CANCELLED: 'Abgebrochen',
};

export default async function RequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reopenConflict?: string }>;
}) {
  const session = await requireStaffPage();

  const { id } = await params;
  const { reopenConflict } = await searchParams;
  const { tenantId, staffId } = session.user;

  const reqRow = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const row = await tx.request.findUnique({
        where: { id },
        include: {
          client: true,
          responses: {
            orderBy: { createdAt: 'asc' },
            include: { document: true },
          },
          internalComments: { orderBy: { createdAt: 'asc' } },
        },
      });
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Anforderung eines
      // gesperrten Mandanten verhält sich wie nicht vorhanden (kein
      // Existenz-Leak per direkter URL).
      if (row && !(await canAccessClientTx(tx, session, row.clientId))) return null;
      return row;
    },
  );

  if (!reqRow) notFound();

  return (
    <div className="p-8 max-w-3xl">
      {reopenConflict === '1' && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Diese Anforderung kann nicht wieder geöffnet werden, weil für dasselbe GwG-Ausweisdokument
          bereits eine andere aktive Anforderung besteht.
        </div>
      )}
      <div className="flex items-start gap-4 mb-6">
        <Link
          href={`/staff/clients/${reqRow.client.id}`}
          aria-label="Zurück"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">{reqRow.title}</h1>
            <span
              className={
                reqRow.status === 'CLOSED'
                  ? 'badge-gray'
                  : reqRow.status === 'RESPONDED'
                    ? 'badge-green'
                    : 'badge-yellow'
              }
            >
              {statusLabels[reqRow.status]}
            </span>
          </div>
          <p className="text-muted text-sm">
            an {reqRow.client.name}
            {reqRow.dueAt ? ` · fällig ${fmtDateShort(reqRow.dueAt)}` : ''}
          </p>
          <p className="mt-1 text-xs text-disabled">
            Erstellt am {fmtDateTimeShort(reqRow.createdAt)}
          </p>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wide mb-2">
          Beschreibung
        </h2>
        <p className="text-sm text-primary whitespace-pre-wrap">{reqRow.description}</p>
      </div>

      <div className="card overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">
            Konversation ({reqRow.responses.length})
          </h2>
        </div>
        <div className="divide-y divide-border-subtle">
          {reqRow.responses.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-disabled">
              Noch keine Antworten.
            </div>
          ) : (
            reqRow.responses.map((r) => (
              <div key={r.id} className="px-6 py-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={r.authorType === 'STAFF' ? 'badge-gray' : 'badge-green'}>
                    {r.authorType === 'STAFF' ? 'Mitarbeiter' : 'Mandant'}
                  </span>
                  <span className="text-xs text-disabled">{fmtDateTimeShort(r.createdAt)}</span>
                </div>
                <p className="text-sm text-primary whitespace-pre-wrap">{r.message}</p>
                {r.document && (
                  <p className="mt-2 text-xs text-muted">Dokument: {r.document.title}</p>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card mb-6 overflow-hidden border-default border-l-4 border-l-amber-500 bg-surface-raised">
        <div className="border-b border-default px-6 py-4">
          <h2 className="text-sm font-medium text-primary">
            Kanzlei-intern ({reqRow.internalComments.length})
          </h2>
          <p className="mt-1 text-xs text-muted">
            Diese Notizen sind nicht im Mandantenportal sichtbar und lösen keine E-Mail aus.
          </p>
        </div>
        {reqRow.internalComments.length > 0 && (
          <div className="divide-y divide-border-subtle">
            {reqRow.internalComments.map((comment) => (
              <div key={comment.id} className="px-6 py-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="badge-yellow">Intern · {comment.authorName}</span>
                  <span className="text-xs text-muted">{fmtDateTimeShort(comment.createdAt)}</span>
                </div>
                <p className="text-sm text-primary whitespace-pre-wrap">{comment.body}</p>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-default px-6 py-4">
          <InternalCommentForm requestId={reqRow.id} />
        </div>
      </div>

      {(reqRow.status === 'OPEN' || reqRow.status === 'IN_PROGRESS') && (
        <div className="card p-6 mb-4">
          <h2 className="text-sm font-medium text-primary mb-3">Antwort an den Mandanten</h2>
          <StaffResponseForm requestId={reqRow.id} />
        </div>
      )}

      {reqRow.status !== 'CLOSED' && reqRow.status !== 'CANCELLED' && (
        <form action={closeRequestAction}>
          <input type="hidden" name="requestId" value={reqRow.id} />
          <button type="submit" className="btn-secondary">
            Anforderung schließen
          </button>
        </form>
      )}
      {(reqRow.status === 'CLOSED' || reqRow.status === 'RESPONDED') && (
        <form action={reopenRequestAction}>
          <input type="hidden" name="requestId" value={reqRow.id} />
          <button type="submit" className="btn-secondary">
            Anforderung wieder öffnen
          </button>
        </form>
      )}
    </div>
  );
}
