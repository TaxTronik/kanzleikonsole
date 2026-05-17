import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Inbox, FileDown, Search } from 'lucide-react';
import { OffsetPagination } from '@/components/offset-pagination';
import { BulkToolbar } from './bulk-toolbar';
import type { Prisma, RequestStatus } from '@prisma/client';

const PAGE_SIZE = 50;
const statusLabels: Record<string, string> = {
  OPEN: 'Offen',
  IN_PROGRESS: 'In Bearbeitung',
  RESPONDED: 'Beantwortet',
  CLOSED: 'Geschlossen',
  CANCELLED: 'Abgebrochen',
};

const priorityLabels: Record<string, string> = {
  LOW: 'Niedrig',
  NORMAL: 'Normal',
  HIGH: 'Hoch',
  URGENT: 'Dringend',
};

type SortKey = 'created' | 'due' | 'client' | 'datev' | 'addison';
type SortDir = 'asc' | 'desc';

interface Search {
  status?: string;
  q?: string;
  sort?: SortKey;
  dir?: SortDir;
  mine?: '1';
  page?: string;
}

function parseSort(sp: Search): { sort: SortKey; dir: SortDir } {
  const sort: SortKey =
    sp.sort === 'due' || sp.sort === 'client' || sp.sort === 'datev' || sp.sort === 'addison'
      ? sp.sort
      : 'created';
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  return { sort, dir };
}

function orderByFor(sort: SortKey, dir: SortDir): Prisma.RequestOrderByWithRelationInput[] {
  switch (sort) {
    case 'due':
      return [{ dueAt: { sort: dir, nulls: 'last' } }, { createdAt: 'desc' }];
    case 'client':
      return [{ client: { name: dir } }, { createdAt: 'desc' }];
    case 'datev':
      return [{ client: { datevNo: { sort: dir, nulls: 'last' } } }, { createdAt: 'desc' }];
    case 'addison':
      return [{ client: { addisonNo: { sort: dir, nulls: 'last' } } }, { createdAt: 'desc' }];
    case 'created':
    default:
      return [{ createdAt: dir }];
  }
}

export default async function RequestsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const sp = await searchParams;
  const filterStatus = sp.status && Object.keys(statusLabels).includes(sp.status)
    ? (sp.status as keyof typeof statusLabels)
    : null;
  const { sort, dir } = parseSort(sp);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const mine = sp.mine === '1';

  const { tenantId, staffId } = session.user;

  const where: Prisma.RequestWhereInput = {};
  if (filterStatus) where.status = filterStatus as RequestStatus;
  const clientFilters: Prisma.ClientWhereInput[] = [];
  if (sp.q) {
    where.OR = [
      { title: { contains: sp.q, mode: 'insensitive' } },
      { client: { name: { contains: sp.q, mode: 'insensitive' } } },
      { client: { datevNo: { contains: sp.q, mode: 'insensitive' } } },
      { client: { addisonNo: { contains: sp.q, mode: 'insensitive' } } },
    ];
  }
  if (mine) {
    clientFilters.push({ responsibilities: { some: { staffId } } });
  }
  if (clientFilters.length > 0) {
    where.client = clientFilters.length === 1 ? clientFilters[0] : { AND: clientFilters };
  }

  const [requests, totalCount] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.request.findMany({
          where,
          orderBy: orderByFor(sort, dir),
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: {
            client: { select: { id: true, name: true, datevNo: true, addisonNo: true } },
            _count: { select: { responses: true } },
          },
        }),
        tx.request.count({ where }),
      ]),
  );

  const baseQs = new URLSearchParams();
  if (filterStatus) baseQs.set('status', filterStatus);
  if (sp.q) baseQs.set('q', sp.q);
  if (sort !== 'created') baseQs.set('sort', sort);
  if (dir !== 'desc') baseQs.set('dir', dir);
  if (mine) baseQs.set('mine', '1');

  const tabs: Array<{ key: string; label: string }> = [
    { key: '', label: 'Alle' },
    { key: 'OPEN', label: 'Offen' },
    { key: 'IN_PROGRESS', label: 'In Bearbeitung' },
    { key: 'RESPONDED', label: 'Beantwortet' },
    { key: 'CLOSED', label: 'Geschlossen' },
  ];

  function tabHref(statusKey: string): string {
    const qs = new URLSearchParams(baseQs);
    qs.delete('status');
    qs.delete('page');
    if (statusKey) qs.set('status', statusKey);
    const q = qs.toString();
    return q ? `/staff/requests?${q}` : '/staff/requests';
  }

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Anforderungen</h1>
          <p className="text-gray-500 text-sm">
            Alle laufenden Anforderungen an Mandanten.
          </p>
        </div>
        <a
          href={`/api/staff/requests/export${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
          className="btn-secondary"
        >
          <FileDown className="h-4 w-4" />
          CSV
        </a>
      </div>

      {/* Status-Tabs */}
      <div className="border-b border-gray-200 mb-4">
        <nav className="-mb-px flex gap-6">
          {tabs.map((t) => {
            const active = (filterStatus ?? '') === t.key;
            return (
              <Link
                key={t.key}
                href={tabHref(t.key)}
                className={
                  active
                    ? 'border-b-2 border-brand-600 text-brand-700 px-1 py-2 text-sm font-medium'
                    : 'border-b-2 border-transparent text-gray-500 hover:text-gray-700 px-1 py-2 text-sm font-medium'
                }
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Filter */}
      <form action="/staff/requests" method="get" className="card p-4 mb-4 space-y-3">
        {filterStatus && <input type="hidden" name="status" value={filterStatus} />}
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[240px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="search"
              name="q"
              className="input pl-9"
              placeholder="Titel, Mandant, DATEV- oder Addison-Nr.…"
              defaultValue={sp.q ?? ''}
            />
          </div>
          <select name="sort" className="input w-44" defaultValue={sort}>
            <option value="created">Sortierung: Angelegt</option>
            <option value="due">Sortierung: Fällig</option>
            <option value="client">Sortierung: Mandant</option>
            <option value="datev">Sortierung: DATEV-Nr.</option>
            <option value="addison">Sortierung: Addison-Nr.</option>
          </select>
          <select name="dir" className="input w-32" defaultValue={dir}>
            <option value="desc">Absteigend</option>
            <option value="asc">Aufsteigend</option>
          </select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              name="mine"
              value="1"
              defaultChecked={mine}
              className="rounded border-gray-300 text-brand-600"
            />
            Nur meine Mandanten
          </label>
          <div className="flex gap-2">
            {(sp.q || sort !== 'created' || dir !== 'desc' || mine) && (
              <Link href={filterStatus ? `/staff/requests?status=${filterStatus}` : '/staff/requests'} className="btn-secondary">
                Reset
              </Link>
            )}
            <button type="submit" className="btn-primary">Anwenden</button>
          </div>
        </div>
      </form>

      <div className="card overflow-hidden">
        {requests.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Inbox className="h-12 w-12 text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-400">Keine Anforderungen gefunden.</p>
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-3 w-8"></th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Mandant</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">DATEV / Addison</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Titel</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Priorität</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Antw.</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Fällig</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {requests.map((r) => {
                  const closable = r.status !== 'CLOSED' && r.status !== 'CANCELLED';
                  return (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-3">
                        {closable && (
                          <input
                            type="checkbox"
                            data-bulk-id={r.id}
                            className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                            aria-label="Auswählen"
                          />
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <Link href={`/staff/clients/${r.client.id}`} className="text-gray-700 hover:underline">
                          {r.client.name}
                        </Link>
                      </td>
                      <td className="px-6 py-3 text-xs font-mono text-gray-500">
                        {r.client.datevNo ?? '—'}
                        {r.client.addisonNo ? ` / ${r.client.addisonNo}` : ''}
                      </td>
                      <td className="px-6 py-3 font-medium text-gray-900">
                        <Link href={`/staff/requests/${r.id}`} className="hover:underline">
                          {r.title}
                        </Link>
                      </td>
                      <td className="px-6 py-3">
                        {r.status === 'OPEN' && <span className="badge-yellow">{statusLabels[r.status]}</span>}
                        {r.status === 'IN_PROGRESS' && <span className="badge-yellow">{statusLabels[r.status]}</span>}
                        {r.status === 'RESPONDED' && <span className="badge-green">{statusLabels[r.status]}</span>}
                        {r.status === 'CLOSED' && <span className="badge-gray">{statusLabels[r.status]}</span>}
                        {r.status === 'CANCELLED' && <span className="badge-gray">{statusLabels[r.status]}</span>}
                      </td>
                      <td className="px-6 py-3">
                        {r.priority === 'URGENT' && <span className="badge-red">{priorityLabels[r.priority]}</span>}
                        {r.priority === 'HIGH' && <span className="badge-yellow">{priorityLabels[r.priority]}</span>}
                        {r.priority === 'NORMAL' && <span className="text-gray-600">{priorityLabels[r.priority]}</span>}
                        {r.priority === 'LOW' && <span className="text-gray-400">{priorityLabels[r.priority]}</span>}
                      </td>
                      <td className="px-6 py-3 text-gray-600">{r._count.responses}</td>
                      <td className="px-6 py-3 text-gray-600">
                        {r.dueAt ? new Intl.DateTimeFormat('de-DE').format(r.dueAt) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <BulkToolbar
              closableIds={requests
                .filter((r) => r.status !== 'CLOSED' && r.status !== 'CANCELLED')
                .map((r) => r.id)}
            />
            <OffsetPagination
              basePath="/staff/requests"
              baseQs={baseQs}
              page={page}
              pageSize={PAGE_SIZE}
              totalCount={totalCount}
            />
          </>
        )}
      </div>
    </div>
  );
}
