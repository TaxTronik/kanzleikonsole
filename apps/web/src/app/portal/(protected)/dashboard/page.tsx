import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Inbox, FileText, Clock } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort } from '@/lib/fmt';

export default async function PortalDashboardPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;

  const [openRequestCount, documentCount, recentRequests] = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) =>
      Promise.all([
        tx.request.count({
          where: { clientId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        }),
        // Portal-Sicht: nur freigegebene & nicht soft-gelöschte Dokumente.
        tx.document.count({ where: { clientId, deletedAt: null, sharedWithClientAt: { not: null } } }),
        tx.request.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      ]),
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">
        Hallo {session.user.fullName?.split(' ')[0] ?? ''}
      </h1>
      <p className="text-muted text-sm mb-8">
        Übersicht über offene Anforderungen Ihrer Kanzlei.
      </p>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <KpiCard
          icon={Inbox}
          label="Offene Anforderungen"
          value={openRequestCount}
          accent={openRequestCount > 0 ? 'yellow' : 'gray'}
        />
        <KpiCard icon={FileText} label="Dokumente" value={documentCount} accent="gray" />
        <KpiCard
          icon={Clock}
          label="Letzter Login"
          value={
            session.user.email ? '—' : '—'
          }
          accent="gray"
          large={false}
        />
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-default flex items-center justify-between">
          <h2 className="text-sm font-medium text-primary">Aktuelle Anforderungen</h2>
          <Link href="/portal/requests" className="text-sm text-brand-700 hover:underline">
            Alle anzeigen
          </Link>
        </div>
        {recentRequests.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-disabled">
            Keine Anforderungen.
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {recentRequests.map((r) => (
              <li key={r.id} className="px-6 py-4">
                <Link href={`/portal/requests/${r.id}`} className="block hover:underline">
                  <span className="font-medium text-primary">{r.title}</span>
                </Link>
                <p className="text-xs text-muted mt-1">
                  {r.status === 'OPEN' || r.status === 'IN_PROGRESS' ? 'Offen' : 'Erledigt'}
                  {r.dueAt ? ` · fällig ${fmtDateShort(r.dueAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  accent,
  large = true,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  accent: 'yellow' | 'gray';
  large?: boolean;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-center gap-3 mb-2">
        <Icon className={accent === 'yellow' ? 'h-4 w-4 text-yellow-600' : 'h-4 w-4 text-disabled'} />
        <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      </div>
      <p className={large ? 'text-3xl font-bold text-primary' : 'text-lg font-semibold text-primary'}>
        {value}
      </p>
    </div>
  );
}
