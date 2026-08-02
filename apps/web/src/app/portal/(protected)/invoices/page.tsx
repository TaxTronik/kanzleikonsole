import { redirect } from 'next/navigation';
import { Receipt } from 'lucide-react';
import { DocumentActions } from '@/components/document-actions';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';

import { fmtDateShort, fmtEUR, berlinTodayUtcMidnight } from '@/lib/fmt';
import { INVOICE_STATUS_LABELS } from '@/lib/domain-labels';

const portalInvoiceStatusLabels: Readonly<Record<string, string>> = {
  ...INVOICE_STATUS_LABELS,
  SENT: 'Offen',
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
        // mimeType: entscheidet, ob das Auge angeboten wird (XML bekommt keins).
        include: { document: { select: { id: true, title: true, mimeType: true } } },
      }),
  );

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">Rechnungen</h1>
      <p className="text-muted text-sm mb-6">Rechnungen Ihrer Kanzlei.</p>

      <div className="card overflow-hidden">
        {invoices.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Receipt className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Rechnungen vorhanden.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="th">Nr.</th>
                <th className="th">Betreff</th>
                <th className="th">Datum</th>
                <th className="th">Fällig</th>
                <th className="th th-right">Brutto</th>
                <th className="th">Status</th>
                <th className="th">PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {invoices.map((i) => {
                // Überfällig erst ab dem Tag NACH der Fälligkeit (§ 271 BGB) —
                // konsistent zum invoice-overdue-check-Worker.
                const overdue = i.status === 'SENT' && i.dueDate < berlinTodayUtcMidnight();
                return (
                  <tr key={i.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-primary">{i.number}</td>
                    <td className="px-6 py-4 text-secondary">{i.subject}</td>
                    <td className="px-6 py-4 text-secondary">{fmtDateShort(i.issueDate)}</td>
                    <td className={overdue ? 'px-6 py-4 text-red-700' : 'px-6 py-4 text-secondary'}>
                      {fmtDateShort(i.dueDate)}
                    </td>
                    <td className="px-6 py-4 text-right font-mono tabular-nums">
                      {fmtEUR(i.totalAmount)}
                    </td>
                    <td className="px-6 py-4">
                      {i.status === 'SENT' &&
                        (overdue ? (
                          <span className="badge-red">Überfällig</span>
                        ) : (
                          <span className="badge-yellow">
                            {portalInvoiceStatusLabels[i.status]}
                          </span>
                        ))}
                      {i.status === 'PAID' && (
                        <span className="badge-green">{portalInvoiceStatusLabels[i.status]}</span>
                      )}
                      {i.status === 'OVERDUE' && (
                        <span className="badge-red">{portalInvoiceStatusLabels[i.status]}</span>
                      )}
                      {i.status === 'CANCELLED' && (
                        <span className="badge-gray">{portalInvoiceStatusLabels[i.status]}</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {i.document ? (
                        <DocumentActions
                          documentId={i.document.id}
                          documentTitle={i.document.title}
                          mimeType={i.document.mimeType}
                          apiPrefix="/api/portal"
                        />
                      ) : (
                        <span className="text-disabled text-xs">—</span>
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
