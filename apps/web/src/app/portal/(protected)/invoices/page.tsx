import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';

const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'Offen',
  PAID: 'Bezahlt',
  OVERDUE: 'Überfällig',
  CANCELLED: 'Storniert',
};

export default async function PortalInvoicesPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;

  const invoices = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.invoice.findMany({
        // Mandant sieht keine Entwürfe
        where: { clientId, status: { not: 'DRAFT' } },
        orderBy: [{ status: 'asc' }, { issueDate: 'desc' }],
        include: { document: { select: { id: true, title: true } } },
      }),
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Rechnungen</h1>
      <p className="text-gray-500 text-sm mb-6">
        Rechnungen Ihrer Kanzlei.
      </p>

      <div className="card overflow-hidden">
        {invoices.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Receipt className="h-12 w-12 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Keine Rechnungen vorhanden.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Nr.</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Betreff</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Datum</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Fällig</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Brutto</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {invoices.map((i) => {
                const overdue = i.status === 'SENT' && i.dueDate < new Date();
                return (
                  <tr key={i.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-gray-900">{i.number}</td>
                    <td className="px-6 py-4 text-gray-700">{i.subject}</td>
                    <td className="px-6 py-4 text-gray-600">
                      {new Intl.DateTimeFormat('de-DE').format(i.issueDate)}
                    </td>
                    <td className={overdue ? 'px-6 py-4 text-red-700' : 'px-6 py-4 text-gray-600'}>
                      {new Intl.DateTimeFormat('de-DE').format(i.dueDate)}
                    </td>
                    <td className="px-6 py-4 text-right font-mono tabular-nums">
                      {fmtEUR(i.totalAmount)}
                    </td>
                    <td className="px-6 py-4">
                      {i.status === 'SENT' && (overdue ? <span className="badge-red">Überfällig</span> : <span className="badge-yellow">{statusLabels[i.status]}</span>)}
                      {i.status === 'PAID' && <span className="badge-green">{statusLabels[i.status]}</span>}
                      {i.status === 'OVERDUE' && <span className="badge-red">{statusLabels[i.status]}</span>}
                      {i.status === 'CANCELLED' && <span className="badge-gray">{statusLabels[i.status]}</span>}
                    </td>
                    <td className="px-6 py-4">
                      {i.document ? (
                        <Link
                          href={`/api/portal/documents/${i.document.id}/download`}
                          className="text-brand-700 hover:underline text-xs"
                        >
                          Öffnen
                        </Link>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
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

function fmtEUR(n: { toString(): string }): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(n.toString()));
}
