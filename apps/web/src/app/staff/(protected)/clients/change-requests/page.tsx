import Link from 'next/link';
import { withTenantContext } from '@taxtronik/db';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { OffsetPagination } from '@/components/offset-pagination';
import { fmtDateTimeShort } from '@/lib/fmt';
import { clampListPage, parseListPage, type ListParam } from '@/lib/list-page';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { requireStaffPage } from '@/server/auth/staff-page';
import { pendingMasterChangesWhere } from '@/server/clients/pending-master-changes';

const PAGE_SIZE = 50;

export default async function PendingChangeRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: ListParam }>;
}) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const requestedPage = parseListPage((await searchParams).page);
  const { requests, page, total } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const where = pendingMasterChangesWhere(await accessibleClientsWhereFor(tx, session));
      const total = await tx.clientMasterChangeRequest.count({ where });
      const page = clampListPage(requestedPage, total, PAGE_SIZE);
      const requests = await tx.clientMasterChangeRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          createdAt: true,
          client: { select: { id: true, name: true } },
          contact: { select: { fullName: true } },
        },
      });
      return { requests, page, total };
    },
    { isolationLevel: 'RepeatableRead' },
  );

  return (
    <div className="max-w-4xl p-4 sm:p-8">
      <Link href="/staff/dashboard" className="back-link mb-3">
        <ArrowLeft className="h-3 w-3" /> Dashboard
      </Link>
      <h1 className="page-title mb-4">Offene Stammdaten-Anträge</h1>
      <div className="card">
        {requests.length ? (
          <ul className="divide-y divide-border-subtle">
            {requests.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/staff/clients/${request.client.id}/change-requests?request=${request.id}`}
                  className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50"
                >
                  <span className="min-w-0 break-words">
                    <span className="block font-medium text-primary">{request.client.name}</span>
                    <span className="text-sm text-secondary">
                      {request.contact.fullName} · {fmtDateTimeShort(request.createdAt)}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-6 text-sm text-muted">Keine offenen Stammdaten-Anträge.</p>
        )}
        <OffsetPagination
          basePath="/staff/clients/change-requests"
          baseQs={new URLSearchParams()}
          page={page}
          pageSize={PAGE_SIZE}
          totalCount={total}
        />
      </div>
    </div>
  );
}
