import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ScrollText, Plus } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';

const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'Wartet auf Unterschrift',
  SIGNED: 'Unterschrieben',
  REVOKED: 'Widerrufen',
  EXPIRED: 'Abgelaufen',
};

export default async function PoaListPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { tenantId, staffId } = session.user;

  const poas = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.powerOfAttorney.findMany({
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: { client: { select: { id: true, name: true } } },
        take: 200,
      }),
  );

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Vollmachten</h1>
          <p className="text-gray-500 text-sm">
            Fortgeschrittene elektronische Signatur via Magic-Link + OTP (eIDAS).
          </p>
        </div>
        <Link href="/staff/poa/new" className="btn-primary">
          <Plus className="h-3.5 w-3.5" />
          Neue Vollmacht
        </Link>
      </div>

      <div className="card overflow-hidden">
        {poas.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <ScrollText className="h-12 w-12 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Noch keine Vollmachten.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Betreff</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Mandant</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Unterzeichner</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Datum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {poas.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-900">
                    <Link href={`/staff/poa/${p.id}`} className="hover:underline">
                      {p.subject}
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-gray-700">{p.client.name}</td>
                  <td className="px-6 py-4 text-gray-600">
                    {p.signerName}
                    <br />
                    <span className="text-xs text-gray-400">{p.signerEmail}</span>
                  </td>
                  <td className="px-6 py-4">
                    {p.status === 'DRAFT' && <span className="badge-gray">{statusLabels[p.status]}</span>}
                    {p.status === 'SENT' && <span className="badge-yellow">{statusLabels[p.status]}</span>}
                    {p.status === 'SIGNED' && <span className="badge-green">{statusLabels[p.status]}</span>}
                    {p.status === 'REVOKED' && <span className="badge-red">{statusLabels[p.status]}</span>}
                    {p.status === 'EXPIRED' && <span className="badge-red">{statusLabels[p.status]}</span>}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {p.signedAt
                      ? `unterz. ${new Intl.DateTimeFormat('de-DE').format(p.signedAt)}`
                      : new Intl.DateTimeFormat('de-DE').format(p.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
