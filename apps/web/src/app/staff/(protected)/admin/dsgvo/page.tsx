import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Shield, Plus, AlertTriangle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';

const typeLabels: Record<string, string> = {
  ACCESS: 'Auskunft (Art. 15)',
  RECTIFICATION: 'Berichtigung (Art. 16)',
  ERASURE: 'Löschung (Art. 17)',
  RESTRICTION: 'Einschränkung (Art. 18)',
  PORTABILITY: 'Datenübertragbarkeit (Art. 20)',
  OBJECTION: 'Widerspruch (Art. 21)',
};

const statusLabels: Record<string, string> = {
  RECEIVED: 'Eingegangen',
  IN_PROGRESS: 'In Bearbeitung',
  COMPLETED: 'Erledigt',
  REJECTED: 'Abgelehnt',
};

export default async function DsgvoPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  const { tenantId, staffId } = session.user;

  const requests = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.dsgvoRequest.findMany({
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        take: 200,
      }),
  );

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">DSGVO-Anfragen</h1>
          <p className="text-gray-500 text-sm">
            Auskunft, Berichtigung, Löschung und weitere Betroffenenrechte (Art. 15–21).
          </p>
        </div>
        <Link href="/staff/admin/dsgvo/new" className="btn-primary">
          <Plus className="h-3.5 w-3.5" />
          Neue Anfrage
        </Link>
      </div>

      <div className="card overflow-hidden">
        {requests.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Shield className="h-12 w-12 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Keine DSGVO-Anfragen vorhanden.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Typ</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Betroffene Person</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Frist</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Eingegangen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {requests.map((r) => {
                const overdue = r.dueDate && r.dueDate < new Date() && r.status !== 'COMPLETED' && r.status !== 'REJECTED';
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3">
                      <Link href={`/staff/admin/dsgvo/${r.id}`} className="font-medium text-gray-900 hover:underline">
                        {typeLabels[r.type]}
                      </Link>
                    </td>
                    <td className="px-6 py-3">
                      <p className="text-gray-900">{r.subjectName}</p>
                      <p className="text-xs text-gray-500">{r.subjectEmail}</p>
                    </td>
                    <td className="px-6 py-3">
                      {r.status === 'RECEIVED' && <span className="badge-yellow">{statusLabels[r.status]}</span>}
                      {r.status === 'IN_PROGRESS' && <span className="badge-yellow">{statusLabels[r.status]}</span>}
                      {r.status === 'COMPLETED' && <span className="badge-green">{statusLabels[r.status]}</span>}
                      {r.status === 'REJECTED' && <span className="badge-gray">{statusLabels[r.status]}</span>}
                    </td>
                    <td className={overdue ? 'px-6 py-3 text-red-700' : 'px-6 py-3 text-gray-600'}>
                      <div className="flex items-center gap-1">
                        {overdue && <AlertTriangle className="h-3.5 w-3.5" />}
                        {r.dueDate ? new Intl.DateTimeFormat('de-DE').format(r.dueDate) : '—'}
                      </div>
                    </td>
                    <td className="px-6 py-3 text-gray-600">
                      {new Intl.DateTimeFormat('de-DE').format(r.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
