import { staffAuth } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Plus, User, FileDown, Search, Wand2 } from 'lucide-react';
import { OffsetPagination } from '@/components/offset-pagination';
import type { Prisma } from '@prisma/client';
import { computeOnboardingStatus, type OnboardingStatus } from '@/server/onboarding/status';
import { RecentClients } from '@/components/recent-clients';
import { SavedViews } from '@/components/saved-views';

const PAGE_SIZE = 50;

type SortKey = 'name' | 'datev' | 'addison' | 'created';
type SortDir = 'asc' | 'desc';

interface SearchParams {
  q?: string;
  status?: 'active' | 'pending';
  onboarding?: 'open' | 'in_progress' | 'complete';
  sort?: SortKey;
  dir?: SortDir;
  mine?: '1';
  page?: string;
  denied?: string;
}

function parseSort(sp: SearchParams): { sort: SortKey; dir: SortDir } {
  const sort: SortKey =
    sp.sort === 'datev' || sp.sort === 'addison' || sp.sort === 'created' ? sp.sort : 'name';
  const dir: SortDir = sp.dir === 'desc' ? 'desc' : 'asc';
  return { sort, dir };
}

function orderByFor(sort: SortKey, dir: SortDir): Prisma.ClientOrderByWithRelationInput[] {
  switch (sort) {
    case 'datev':
      return [{ datevNo: { sort: dir, nulls: 'last' } }, { name: 'asc' }];
    case 'addison':
      return [{ addisonNo: { sort: dir, nulls: 'last' } }, { name: 'asc' }];
    case 'created':
      return [{ createdAt: dir }];
    case 'name':
    default:
      return [{ name: dir }];
  }
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const sp = await searchParams;
  const { tenantId, staffId } = session.user;
  const { sort, dir } = parseSort(sp);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const mine = sp.mine === '1';

  const where: Prisma.ClientWhereInput = {};
  if (sp.q) {
    where.OR = [
      { name: { contains: sp.q, mode: 'insensitive' } },
      { datevNo: { contains: sp.q, mode: 'insensitive' } },
      { addisonNo: { contains: sp.q, mode: 'insensitive' } },
      { vatId: { contains: sp.q, mode: 'insensitive' } },
    ];
  }
  if (sp.status === 'active') where.allowActive = true;
  if (sp.status === 'pending') where.allowActive = false;
  if (mine) {
    where.responsibilities = { some: { staffId } };
  }

  // Onboarding-Filter
  if (sp.onboarding === 'complete') {
    where.allowActive = true;
    where.contacts = { some: { active: true } };
  } else if (sp.onboarding === 'open') {
    where.allowActive = false;
    where.contacts = { none: {} };
    where.gwgChecks = { none: {} };
    where.gwgInvites = { none: {} };
    where.poas = { none: {} };
    where.requests = { none: {} };
  } else if (sp.onboarding === 'in_progress') {
    where.AND = [
      {
        OR: [{ allowActive: false }, { contacts: { none: { active: true } } }],
      },
      {
        OR: [
          { contacts: { some: { active: true } } },
          { gwgChecks: { some: {} } },
          { gwgInvites: { some: {} } },
          { poas: { some: {} } },
          { requests: { some: {} } },
        ],
      },
    ];
  }

  const [clients, totalCount] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): gesperrte Mandanten
      // erscheinen gar nicht erst in der Liste (konsistent zu Suche/Export).
      const denied = await inaccessibleClientIdsFor(tx, session);
      if (denied.length) where.id = { notIn: denied };
      return Promise.all([
        tx.client.findMany({
          where,
          orderBy: orderByFor(sort, dir),
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          select: {
            id: true,
            name: true,
            kind: true,
            datevNo: true,
            addisonNo: true,
            allowActive: true,
            priority: true,
            createdAt: true,
            _count: {
              select: {
                documents: true,
                contacts: { where: { active: true } },
                gwgChecks: true,
                gwgInvites: true,
                poas: true,
                requests: true,
              },
            },
          },
        }),
        tx.client.count({ where }),
      ]);
    },
  );

  const baseQs = new URLSearchParams();
  if (sp.q) baseQs.set('q', sp.q);
  if (sp.status) baseQs.set('status', sp.status);
  if (sp.onboarding) baseQs.set('onboarding', sp.onboarding);
  if (sort !== 'name') baseQs.set('sort', sort);
  if (dir !== 'asc') baseQs.set('dir', dir);
  if (mine) baseQs.set('mine', '1');

  const kindLabels: Record<string, string> = {
    NATPERS: 'Natürliche Person',
    JURPERS: 'Juristische Person',
    PERSGES: 'Personengesellschaft',
  };

  return (
    <div className="p-8">
      {sp.denied === '1' && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          Kein Zugriff auf diesen Mandanten — er ist als vertraulich markiert oder Ihnen nicht
          zugeordnet.
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Mandanten</h1>
          <p className="text-muted mt-1">{totalCount.toLocaleString('de-DE')} Treffer</p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/staff/clients/export${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
            className="btn-secondary"
          >
            <FileDown className="h-4 w-4" />
            CSV
          </a>
          <Link href="/staff/clients/new" className="btn-secondary">
            <Plus className="h-4 w-4" />
            Schnell anlegen
          </Link>
          <Link href="/staff/clients/onboarding/new" className="btn-primary">
            <Plus className="h-4 w-4" />
            Onboarding starten
          </Link>
        </div>
      </div>

      <div className="mb-4 space-y-2">
        <SavedViews />
        <RecentClients />
      </div>

      {/* Filter */}
      <form action="/staff/clients" method="get" className="card p-4 mb-4 space-y-3">
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[240px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-disabled" />
            <input
              type="search"
              name="q"
              className="input pl-9"
              placeholder="Name, DATEV-, Addison-Nr. oder USt-ID…"
              defaultValue={sp.q ?? ''}
            />
          </div>
          <select name="status" className="input w-44" defaultValue={sp.status ?? ''}>
            <option value="">Alle Status</option>
            <option value="active">Nur aktive</option>
            <option value="pending">Nur GwG-ausstehend</option>
          </select>
          <select name="onboarding" className="input w-52" defaultValue={sp.onboarding ?? ''}>
            <option value="">Onboarding: alle</option>
            <option value="open">Onboarding: offen</option>
            <option value="in_progress">Onboarding: läuft</option>
            <option value="complete">Onboarding: abgeschlossen</option>
          </select>
          <select name="sort" className="input w-44" defaultValue={sort}>
            <option value="name">Sortierung: Name</option>
            <option value="datev">Sortierung: DATEV-Nr.</option>
            <option value="addison">Sortierung: Addison-Nr.</option>
            <option value="created">Sortierung: Angelegt</option>
          </select>
          <select name="dir" className="input w-32" defaultValue={dir}>
            <option value="asc">Aufsteigend</option>
            <option value="desc">Absteigend</option>
          </select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              name="mine"
              value="1"
              defaultChecked={mine}
              className="rounded border-strong text-brand-600"
            />
            Nur meine Mandanten
          </label>
          <div className="flex gap-2">
            {(sp.q || sp.status || sort !== 'name' || dir !== 'asc' || mine) && (
              <Link href="/staff/clients" className="btn-secondary">
                Reset
              </Link>
            )}
            <button type="submit" className="btn-primary">
              Anwenden
            </button>
          </div>
        </div>
      </form>

      {clients.length === 0 ? (
        <div className="card p-12 text-center">
          <User className="h-12 w-12 text-disabled mx-auto mb-4" />
          <h3 className="text-sm font-medium text-primary mb-1">
            {sp.q || sp.status || mine ? 'Keine Treffer' : 'Noch keine Mandanten'}
          </h3>
          <p className="text-sm text-muted mb-4">
            {sp.q || sp.status || mine
              ? 'Filter anpassen oder zurücksetzen.'
              : 'Lege den ersten Mandanten an, um zu beginnen.'}
          </p>
          {!sp.q && !sp.status && !mine && (
            <Link href="/staff/clients/onboarding/new" className="btn-primary">
              Onboarding starten
            </Link>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default bg-gray-50">
                <th className="th">Name</th>
                <th className="th">Typ</th>
                <th className="th">DATEV-Nr.</th>
                <th className="th">Addison-Nr.</th>
                <th className="th">Status</th>
                <th className="th">Onboarding</th>
                <th className="th">Dokumente</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {clients.map((client) => (
                <tr key={client.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-3">
                    <Link
                      href={`/staff/clients/${client.id}`}
                      className="font-medium text-primary hover:text-brand-600 inline-flex items-center gap-2"
                    >
                      {client.priority && (
                        <span
                          className={
                            client.priority === 'A'
                              ? 'inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                              : client.priority === 'B'
                                ? 'inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                : 'inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-gray-100 text-secondary'
                          }
                          title={`Priorität ${client.priority}`}
                        >
                          {client.priority}
                        </span>
                      )}
                      {client.name}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-secondary">
                    {kindLabels[client.kind] ?? client.kind}
                  </td>
                  <td className="px-6 py-3 text-secondary font-mono text-xs">
                    {client.datevNo ?? '—'}
                  </td>
                  <td className="px-6 py-3 text-secondary font-mono text-xs">
                    {client.addisonNo ?? '—'}
                  </td>
                  <td className="px-6 py-3">
                    {client.allowActive ? (
                      <span className="badge-green">Aktiv</span>
                    ) : (
                      <span className="badge-yellow">GwG ausstehend</span>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    {(() => {
                      const ob: OnboardingStatus = computeOnboardingStatus({
                        allowActive: client.allowActive,
                        contactsActive: client._count.contacts,
                        gwgChecks: client._count.gwgChecks,
                        gwgInvites: client._count.gwgInvites,
                        poas: client._count.poas,
                        requests: client._count.requests,
                      });
                      if (ob === 'COMPLETE') {
                        return <span className="badge-green">Abgeschlossen</span>;
                      }
                      if (ob === 'IN_PROGRESS') {
                        return (
                          <Link
                            href={`/staff/clients/onboarding/${client.id}`}
                            className="badge-yellow inline-flex items-center gap-1 hover:underline"
                            title="Onboarding fortsetzen"
                          >
                            <Wand2 className="h-3 w-3" /> Läuft
                          </Link>
                        );
                      }
                      return (
                        <Link
                          href={`/staff/clients/onboarding/${client.id}`}
                          className="badge-red inline-flex items-center gap-1 hover:underline"
                          title="Onboarding starten"
                        >
                          <Wand2 className="h-3 w-3" /> Offen
                        </Link>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-3 text-secondary">{client._count.documents}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <OffsetPagination
            basePath="/staff/clients"
            baseQs={baseQs}
            page={page}
            pageSize={PAGE_SIZE}
            totalCount={totalCount}
          />
        </div>
      )}
    </div>
  );
}
