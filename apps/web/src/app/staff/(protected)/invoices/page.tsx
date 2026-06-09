import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Receipt, Plus, FileDown } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { Pagination } from '@/components/pagination';
import type { Prisma, InvoiceStatus } from '@prisma/client';

import { fmtDateShort, fmtEUR } from '@/lib/fmt';
const PAGE_SIZE = 50;
const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'Versendet',
  PAID: 'Bezahlt',
  OVERDUE: 'Überfällig',
  CANCELLED: 'Storniert',
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const sp = await searchParams;
  const filterStatus = sp.status && Object.keys(statusLabels).includes(sp.status)
    ? (sp.status as keyof typeof statusLabels)
    : null;

  const { tenantId, staffId } = session.user;

  const where: Prisma.InvoiceWhereInput = {};
  if (filterStatus) where.status = filterStatus as InvoiceStatus;
  if (sp.cursor) where.id = { lt: sp.cursor };

  const [invoices, totalCount] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Rechnungen
      // gesperrter Mandanten ausblenden (konsistent zum CSV-Export).
      const denied = await inaccessibleClientIdsFor(tx, session);
      if (denied.length) where.clientId = { notIn: denied };
      return Promise.all([
        tx.invoice.findMany({
          where,
          orderBy: { id: 'desc' },
          take: PAGE_SIZE + 1,
          include: { client: { select: { id: true, name: true } } },
        }),
        tx.invoice.count({ where: sp.cursor ? { ...where, id: undefined } : where }),
      ]);
    },
  );

  const hasNext = invoices.length > PAGE_SIZE;
  const visible = invoices.slice(0, PAGE_SIZE);
  const nextCursor = hasNext ? visible[visible.length - 1]!.id : null;
  const baseQs = new URLSearchParams();
  if (filterStatus) baseQs.set('status', filterStatus);

  const tabs = [
    { key: '', label: 'Alle' },
    { key: 'DRAFT', label: 'Entwurf' },
    { key: 'SENT', label: 'Versendet' },
    { key: 'PAID', label: 'Bezahlt' },
    { key: 'CANCELLED', label: 'Storniert' },
  ];

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Rechnungen</h1>
          <p className="text-muted text-sm">
            B2B: Pflicht XRechnung/ZUGFeRD ab 2025.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/staff/invoices/export${filterStatus ? '?status=' + filterStatus : ''}`}
            className="btn-secondary"
          >
            <FileDown className="h-3.5 w-3.5" />
            CSV
          </a>
          <Link href="/staff/invoices/new" className="btn-primary">
            <Plus className="h-3.5 w-3.5" />
            Neue Rechnung
          </Link>
        </div>
      </div>

      <div className="border-b border-default mb-4">
        <nav className="-mb-px flex gap-6">
          {tabs.map((t) => {
            const active = (filterStatus ?? '') === t.key;
            const href = t.key ? `/staff/invoices?status=${t.key}` : '/staff/invoices';
            return (
              <Link
                key={t.key}
                href={href}
                className={
                  active
                    ? 'border-b-2 border-brand-600 text-brand-700 px-1 py-2 text-sm font-medium'
                    : 'border-b-2 border-transparent text-muted hover:text-secondary px-1 py-2 text-sm font-medium'
                }
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="card overflow-hidden">
        {visible.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Receipt className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Rechnungen gefunden.</p>
          </div>
        ) : (
          <>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="th">Nr.</th>
                <th className="th">Mandant</th>
                <th className="th">Datum</th>
                <th className="th">Fällig</th>
                <th className="th th-right">Brutto</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visible.map((i) => {
                const overdue =
                  i.status === 'SENT' && i.dueDate < new Date();
                return (
                  <tr key={i.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-medium text-primary">
                      <Link href={`/staff/invoices/${i.id}`} className="hover:underline">
                        {i.number}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-secondary">{i.client.name}</td>
                    <td className="px-6 py-4 text-secondary">
                      {fmtDateShort(i.issueDate)}
                    </td>
                    <td className={overdue ? 'px-6 py-4 text-red-700' : 'px-6 py-4 text-secondary'}>
                      {fmtDateShort(i.dueDate)}
                    </td>
                    <td className="px-6 py-4 text-right font-mono tabular-nums">
                      {fmtEUR(i.totalAmount)}
                    </td>
                    <td className="px-6 py-4">
                      {i.status === 'DRAFT' && <span className="badge-gray">{statusLabels[i.status]}</span>}
                      {i.status === 'SENT' && (overdue ? <span className="badge-red">Überfällig</span> : <span className="badge-yellow">{statusLabels[i.status]}</span>)}
                      {i.status === 'PAID' && <span className="badge-green">{statusLabels[i.status]}</span>}
                      {i.status === 'OVERDUE' && <span className="badge-red">{statusLabels[i.status]}</span>}
                      {i.status === 'CANCELLED' && <span className="badge-gray">{statusLabels[i.status]}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination
            basePath="/staff/invoices"
            baseQs={baseQs}
            currentCursor={sp.cursor ?? null}
            nextCursor={nextCursor}
            totalCount={totalCount}
            shownCount={visible.length}
          />
          </>
        )}
      </div>
    </div>
  );
}

