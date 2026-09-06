import { Prisma, type RequestPriority, type RequestStatus } from '@prisma/client';
import { withTenantContext } from '@taxtronik/db';
import { Inbox, Search } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OffsetPagination } from '@/components/offset-pagination';
import { fmtDateShort } from '@/lib/fmt';
import { portalAuth } from '@/server/auth/portal';
import {
  PORTAL_LIST_PAGE_SIZE,
  clampPortalListPage,
  firstPortalSearchParam,
  normalizePortalListQuery,
  parsePortalListPage,
} from '@/server/portal/list-query';

const statusLabels: Readonly<Record<RequestStatus, string>> = {
  OPEN: 'Offen',
  IN_PROGRESS: 'In Bearbeitung',
  RESPONDED: 'Beantwortet',
  CLOSED: 'Geschlossen',
  CANCELLED: 'Abgebrochen',
};

const priorityLabels: Readonly<Record<RequestPriority, string>> = {
  LOW: 'Niedrig',
  NORMAL: 'Normal',
  HIGH: 'Hoch',
  URGENT: 'Dringend',
};

const requestStatuses = Object.keys(statusLabels) as RequestStatus[];
const requestPriorities = Object.keys(priorityLabels) as RequestPriority[];

type SearchParams = Record<string, string | string[] | undefined>;

function statusBadge(status: RequestStatus): string {
  if (status === 'RESPONDED') return 'badge-green';
  if (status === 'OPEN' || status === 'IN_PROGRESS') return 'badge-yellow';
  return 'badge-gray';
}

export default async function PortalRequestsPage({
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
  const priorityInput = firstPortalSearchParam(sp.priority);
  const status = requestStatuses.includes(statusInput as RequestStatus)
    ? (statusInput as RequestStatus)
    : null;
  const priority = requestPriorities.includes(priorityInput as RequestPriority)
    ? (priorityInput as RequestPriority)
    : null;

  const { requests, totalCount, page } = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`r.client_id = ${clientId}::uuid`,
        // Fachkatalog REQ-LIFECYCLE-001: persönlich gebundene Bescheid-/
        // Feedbackanfragen verwenden ausschließlich ihren eigenen Portalpfad.
        // Derselbe SECURITY-DEFINER-Helper schützt bereits die Detailöffnung.
        Prisma.sql`NOT app.interaction_request(r.id)`,
      ];
      if (status) conditions.push(Prisma.sql`r.status::text = ${status}`);
      if (priority) conditions.push(Prisma.sql`r.priority::text = ${priority}`);
      if (query) {
        // strpos behandelt %, _ und Backslashes als normale Zeichen. Dadurch
        // können Sonderzeichen keine ungewollt breitere Ergebnismenge erzeugen.
        conditions.push(
          Prisma.sql`(strpos(lower(r.title), lower(${query})) > 0 OR strpos(lower(r.description), lower(${query})) > 0)`,
        );
      }
      const whereSql = Prisma.join(conditions, ' AND ');
      const [countRow] = await tx.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(*)::bigint AS count FROM public.request r WHERE ${whereSql}`,
      );
      const count = Number(countRow?.count ?? 0n);
      const safePage = clampPortalListPage(requestedPage, count);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT r.id
          FROM public.request r
          WHERE ${whereSql}
          ORDER BY r.status ASC, r.due_at ASC NULLS LAST, r.created_at DESC, r.id ASC
          LIMIT ${PORTAL_LIST_PAGE_SIZE}
          OFFSET ${(safePage - 1) * PORTAL_LIST_PAGE_SIZE}
        `,
      );
      const ids = rows.map((row) => row.id);
      const hydrated = ids.length
        ? await tx.request.findMany({
            where: { clientId, id: { in: ids } },
            include: { _count: { select: { responses: true } } },
          })
        : [];
      const byId = new Map(hydrated.map((request) => [request.id, request]));
      return {
        requests: ids.flatMap((id) => {
          const request = byId.get(id);
          return request ? [request] : [];
        }),
        totalCount: count,
        page: safePage,
      };
    },
  );

  const baseQs = new URLSearchParams();
  if (query) baseQs.set('q', query);
  if (status) baseQs.set('status', status);
  if (priority) baseQs.set('priority', priority);
  const hasFilters = Boolean(query || status || priority);

  return (
    <div className="p-4 sm:p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">Anforderungen</h1>
      <p className="text-muted text-sm mb-6">
        Anfragen Ihrer Kanzlei, die Sie beantworten oder zu denen Sie Belege hochladen können.
      </p>

      <form action="/portal/requests" method="get" className="card p-4 mb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_12rem_auto] sm:items-end">
          <div className="relative">
            <label className="sr-only" htmlFor="portal-request-search">
              Anforderungen durchsuchen
            </label>
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-disabled"
            />
            <input
              id="portal-request-search"
              type="search"
              name="q"
              className="input pl-9"
              defaultValue={query}
              maxLength={120}
              placeholder="Titel oder Beschreibung"
            />
          </div>
          <div>
            <label className="sr-only" htmlFor="portal-request-status">
              Status filtern
            </label>
            <select
              id="portal-request-status"
              name="status"
              className="input"
              defaultValue={status ?? ''}
            >
              <option value="">Alle Status</option>
              {requestStatuses.map((value) => (
                <option key={value} value={value}>
                  {statusLabels[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="sr-only" htmlFor="portal-request-priority">
              Priorität filtern
            </label>
            <select
              id="portal-request-priority"
              name="priority"
              className="input"
              defaultValue={priority ?? ''}
            >
              <option value="">Alle Prioritäten</option>
              {requestPriorities.map((value) => (
                <option key={value} value={value}>
                  {priorityLabels[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            {hasFilters ? (
              <Link href="/portal/requests" className="btn-secondary flex-1 sm:flex-none">
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
        {requests.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Inbox className="h-12 w-12 text-disabled mx-auto mb-3" />
            <p className="text-sm text-disabled">Keine Anforderungen gefunden.</p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border-subtle">
              {requests.map((request) => (
                <li key={request.id} className="hover:bg-gray-50">
                  <Link href={`/portal/requests/${request.id}`} className="block px-4 py-4 sm:px-6">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-medium text-primary break-words">{request.title}</p>
                        <p className="mt-1 text-xs text-muted">
                          {request.dueAt ? `Fällig ${fmtDateShort(request.dueAt)} · ` : ''}
                          {request._count.responses} Antwort
                          {request._count.responses === 1 ? '' : 'en'}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <span className={statusBadge(request.status)}>
                          {statusLabels[request.status]}
                        </span>
                        <span className="text-xs text-muted">
                          {priorityLabels[request.priority]}
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            <OffsetPagination
              basePath="/portal/requests"
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
