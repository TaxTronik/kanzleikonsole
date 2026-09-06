import type { InvoiceStatus, Prisma } from '@prisma/client';
import { withTenantContext } from '@taxtronik/db';
import { Receipt, Search } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { DocumentActions } from '@/components/document-actions';
import { OffsetPagination } from '@/components/offset-pagination';
import { INVOICE_STATUS_LABELS } from '@/lib/domain-labels';
import { berlinTodayUtcMidnight, fmtDateShort, fmtEUR } from '@/lib/fmt';
import { portalAuth } from '@/server/auth/portal';
import { portalInvoiceVisibilityWhere } from '@/server/invoicing/portal-visibility';
import {
  PORTAL_LIST_PAGE_SIZE,
  clampPortalListPage,
  escapePortalContainsQuery,
  firstPortalSearchParam,
  normalizePortalListQuery,
  parsePortalListPage,
} from '@/server/portal/list-query';

const portalInvoiceStatusLabels: Readonly<Partial<Record<InvoiceStatus, string>>> = {
  SENT: 'Offen',
  PAID: INVOICE_STATUS_LABELS.PAID,
  OVERDUE: INVOICE_STATUS_LABELS.OVERDUE,
  CANCELLED: INVOICE_STATUS_LABELS.CANCELLED,
};
const portalInvoiceStatuses = Object.keys(portalInvoiceStatusLabels) as InvoiceStatus[];
type SearchParams = Record<string, string | string[] | undefined>;

function InvoiceBadge({ status, overdue }: { status: InvoiceStatus; overdue: boolean }) {
  if (status === 'SENT') {
    return overdue ? (
      <span className="badge-red">Überfällig</span>
    ) : (
      <span className="badge-yellow">Offen</span>
    );
  }
  if (status === 'PAID') return <span className="badge-green">Bezahlt</span>;
  if (status === 'OVERDUE') return <span className="badge-red">Überfällig</span>;
  return <span className="badge-gray">Storniert</span>;
}

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const sp = await searchParams;
  const query = normalizePortalListQuery(sp.q);
  const requestedPage = parsePortalListPage(sp.page);
  const statusInput = firstPortalSearchParam(sp.status);
  const status = portalInvoiceStatuses.includes(statusInput as InvoiceStatus)
    ? (statusInput as InvoiceStatus)
    : null;
  const containsQuery = escapePortalContainsQuery(query);

  const { invoices, totalCount, page } = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const filters: Prisma.InvoiceWhereInput[] = [
        // Fachkatalog INV-PORTAL-SHARING-001: Entwürfe und nie versendete
        // Storni bleiben auch in Suche, Zählung und Pagination unsichtbar.
        portalInvoiceVisibilityWhere(clientId),
      ];
      if (status) filters.push({ status });
      if (query) {
        filters.push({
          OR: [
            { number: { contains: containsQuery, mode: 'insensitive' } },
            { subject: { contains: containsQuery, mode: 'insensitive' } },
          ],
        });
      }
      const where: Prisma.InvoiceWhereInput = { AND: filters };
      const count = await tx.invoice.count({ where });
      const safePage = clampPortalListPage(requestedPage, count);
      const rows = await tx.invoice.findMany({
        where,
        orderBy: [{ issueDate: 'desc' }, { id: 'asc' }],
        skip: (safePage - 1) * PORTAL_LIST_PAGE_SIZE,
        take: PORTAL_LIST_PAGE_SIZE,
        // mimeType entscheidet, ob die Vorschau angeboten wird (XML nicht inline).
        include: { document: { select: { id: true, title: true, mimeType: true } } },
      });
      return { invoices: rows, totalCount: count, page: safePage };
    },
  );

  const baseQs = new URLSearchParams();
  if (query) baseQs.set('q', query);
  if (status) baseQs.set('status', status);
  const hasFilters = Boolean(query || status);
  const today = berlinTodayUtcMidnight();

  return (
    <div className="p-4 sm:p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">Rechnungen</h1>
      <p className="text-muted text-sm mb-6">Rechnungen Ihrer Kanzlei.</p>

      <form action="/portal/invoices" method="get" className="card p-4 mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
          <div className="relative">
            <label className="sr-only" htmlFor="portal-invoice-search">
              Rechnungen durchsuchen
            </label>
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-disabled"
            />
            <input
              id="portal-invoice-search"
              type="search"
              name="q"
              className="input pl-9"
              defaultValue={query}
              maxLength={120}
              placeholder="Nummer oder Betreff"
            />
          </div>
          <div>
            <label className="sr-only" htmlFor="portal-invoice-status">
              Rechnungsstatus filtern
            </label>
            <select
              id="portal-invoice-status"
              name="status"
              className="input"
              defaultValue={status ?? ''}
            >
              <option value="">Alle Status</option>
              {portalInvoiceStatuses.map((value) => (
                <option key={value} value={value}>
                  {portalInvoiceStatusLabels[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            {hasFilters ? (
              <Link href="/portal/invoices" className="btn-secondary flex-1 sm:flex-none">
                Zurücksetzen
              </Link>
            ) : null}
            <button type="submit" className="btn-primary flex-1 sm:flex-none">
              Anwenden
            </button>
          </div>
        </div>
      </form>

      <div className="card overflow-hidden">
        {invoices.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Receipt className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Rechnungen gefunden.</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border-subtle md:hidden">
              {invoices.map((invoice) => {
                const overdue = invoice.status === 'SENT' && invoice.dueDate < today;
                return (
                  <li key={invoice.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-primary">{invoice.number}</p>
                        <p className="mt-0.5 break-words text-sm text-secondary">
                          {invoice.subject}
                        </p>
                      </div>
                      <InvoiceBadge status={invoice.status} overdue={overdue} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted">Rechnungsdatum</dt>
                        <dd className="text-secondary">{fmtDateShort(invoice.issueDate)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Fällig</dt>
                        <dd className={overdue ? 'text-red-700' : 'text-secondary'}>
                          {fmtDateShort(invoice.dueDate)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted">Brutto</dt>
                        <dd className="font-mono tabular-nums text-primary">
                          {fmtEUR(invoice.totalAmount)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted">Beleg</dt>
                        <dd className="mt-0.5">
                          {invoice.document ? (
                            <DocumentActions
                              documentId={invoice.document.id}
                              documentTitle={invoice.document.title}
                              mimeType={invoice.document.mimeType}
                              apiPrefix="/api/portal"
                            />
                          ) : (
                            <span className="text-disabled">—</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                  </li>
                );
              })}
            </ul>
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="bg-gray-50 border-b border-default">
                  <th className="th">Nr.</th>
                  <th className="th">Betreff</th>
                  <th className="th">Datum</th>
                  <th className="th">Fällig</th>
                  <th className="th th-right">Brutto</th>
                  <th className="th">Status</th>
                  <th className="th">Beleg</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {invoices.map((invoice) => {
                  const overdue = invoice.status === 'SENT' && invoice.dueDate < today;
                  return (
                    <tr key={invoice.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-medium text-primary">{invoice.number}</td>
                      <td className="px-6 py-4 text-secondary">{invoice.subject}</td>
                      <td className="px-6 py-4 text-secondary">
                        {fmtDateShort(invoice.issueDate)}
                      </td>
                      <td
                        className={overdue ? 'px-6 py-4 text-red-700' : 'px-6 py-4 text-secondary'}
                      >
                        {fmtDateShort(invoice.dueDate)}
                      </td>
                      <td className="px-6 py-4 text-right font-mono tabular-nums">
                        {fmtEUR(invoice.totalAmount)}
                      </td>
                      <td className="px-6 py-4">
                        <InvoiceBadge status={invoice.status} overdue={overdue} />
                      </td>
                      <td className="px-6 py-4">
                        {invoice.document ? (
                          <DocumentActions
                            documentId={invoice.document.id}
                            documentTitle={invoice.document.title}
                            mimeType={invoice.document.mimeType}
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
            <OffsetPagination
              basePath="/portal/invoices"
              baseQs={baseQs}
              page={page}
              pageSize={PORTAL_LIST_PAGE_SIZE}
              totalCount={totalCount}
            />
          </>
        )}
      </div>
    </div>
  );
}
