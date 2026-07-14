import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { closeRequestAction } from '../../clients/[id]/requests/actions';
import { StaffResponseForm } from './staff-response-form';
import { fmtDateShort, fmtDateTimeShort } from '@/lib/fmt';

const statusLabels: Record<string, string> = {
  OPEN: 'Offen',
  IN_PROGRESS: 'In Bearbeitung',
  RESPONDED: 'Beantwortet',
  CLOSED: 'Geschlossen',
  CANCELLED: 'Abgebrochen',
};

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
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
      <div className="flex items-start gap-4 mb-6">
        <Link
          href={`/staff/clients/${reqRow.client.id}`}
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

      {reqRow.status !== 'CLOSED' && reqRow.status !== 'CANCELLED' && (
        <>
          <div className="card p-6 mb-4">
            <h2 className="text-sm font-medium text-primary mb-3">Antworten</h2>
            <StaffResponseForm requestId={reqRow.id} />
          </div>

          <form action={closeRequestAction}>
            <input type="hidden" name="requestId" value={reqRow.id} />
            <button type="submit" className="btn-secondary">
              Anforderung schließen
            </button>
          </form>
        </>
      )}
    </div>
  );
}
