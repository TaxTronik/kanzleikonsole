import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort } from '@/lib/fmt';
import { findDueGwgDeletionDocs } from '@/server/gwg/retention';
import { GwgDeleteButton } from './delete-button';

export default async function GwgRetentionPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');
  const { tenantId, staffId } = session.user;

  const due = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => findDueGwgDeletionDocs(tx),
  );

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">GwG-Pflichtlöschung</h1>
        <p className="text-muted text-sm max-w-3xl">
          GwG-Belege beendeter Mandate, deren gesetzliche Aufbewahrungsfrist abgelaufen
          ist (§ 8 Abs. 4 GwG: 5 Jahre ab Schluss des Kalenderjahres des Mandatsendes).
          Die Vernichtung bestätigt der Berufsträger manuell und ist unwiderruflich.
          Ein Mandat wird über „Mandat beenden" auf der Mandanten-Bearbeitungsseite als
          beendet markiert.
        </p>
      </div>

      <div className="card overflow-hidden">
        {due.length === 0 ? (
          <div className="px-6 py-16 text-center text-muted text-sm">
            Aktuell keine löschreifen GwG-Belege.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted">
                <th className="px-4 py-3 font-medium">Mandant</th>
                <th className="px-4 py-3 font-medium">Beleg</th>
                <th className="px-4 py-3 font-medium">Mandatsende</th>
                <th className="px-4 py-3 font-medium">Frist abgelaufen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {due.map((item) => (
                <tr key={item.documentId} className="border-b last:border-0">
                  <td className="px-4 py-3">{item.clientName}</td>
                  <td className="px-4 py-3">{item.title}</td>
                  <td className="px-4 py-3">{fmtDateShort(item.mandateEndedAt)}</td>
                  <td className="px-4 py-3">{fmtDateShort(item.deletionDeadline)}</td>
                  <td className="px-4 py-3 text-right">
                    <GwgDeleteButton
                      documentId={item.documentId}
                      label={`${item.clientName} — ${item.title}`}
                    />
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
