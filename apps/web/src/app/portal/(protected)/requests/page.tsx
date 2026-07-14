import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort } from '@/lib/fmt';

export default async function PortalRequestsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;

  const requests = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.request.findMany({
        where: { clientId },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
        include: { _count: { select: { responses: true } } },
      }),
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">Anforderungen</h1>
      <p className="text-muted text-sm mb-6">
        Anfragen Ihrer Kanzlei, die Sie beantworten oder Belege dazu hochladen können.
      </p>

      <div className="card overflow-hidden">
        {requests.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Inbox className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Anforderungen vorhanden.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {requests.map((r) => (
              <li key={r.id} className="px-6 py-4 hover:bg-gray-50">
                <Link href={`/portal/requests/${r.id}`} className="block">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="font-medium text-primary">{r.title}</span>
                    {r.status === 'OPEN' && <span className="badge-yellow">Offen</span>}
                    {r.status === 'IN_PROGRESS' && (
                      <span className="badge-yellow">In Bearbeitung</span>
                    )}
                    {r.status === 'RESPONDED' && <span className="badge-green">Beantwortet</span>}
                    {r.status === 'CLOSED' && <span className="badge-gray">Geschlossen</span>}
                    {r.status === 'CANCELLED' && <span className="badge-gray">Abgebrochen</span>}
                  </div>
                  <p className="text-xs text-muted">
                    {r.dueAt ? `fällig ${fmtDateShort(r.dueAt)} · ` : ''}
                    {r._count.responses} Antwort{r._count.responses === 1 ? '' : 'en'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
