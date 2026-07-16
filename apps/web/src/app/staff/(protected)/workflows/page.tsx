// =============================================================================
// /staff/workflows — Aktive Workflow-Vorgänge (global)
//
// Zeigt alle ACTIVE WorkflowInstanzen aller Mandanten. Filter:
//   - mine      : ich habe mindestens einen Item zugewiesen bekommen
//   - mineStart : ich habe diese Instanz gestartet
//   - clientId  : nur Workflows eines bestimmten Mandanten
//
// Pro Instanz: Mandant, Vorlage, Fortschritt, nächste fällige Schritte,
// Links zu /staff/clients/<id>/workflows für Detail-Sicht.
// =============================================================================

import Link from 'next/link';
import { Workflow, Activity, User as UserIcon, AlertCircle, Plus } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { fmtDateShort } from '@/lib/fmt';

interface SearchParams {
  filter?: string;
  clientId?: string;
}

export default async function ActiveWorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const sp = await searchParams;
  const filter = (sp.filter ?? 'all') as 'all' | 'mine' | 'mineStart';
  const clientFilterId = sp.clientId ?? '';

  const [instances, allClients, allStaff] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Gesperrte/vertrauliche Mandanten aus dieser globalen Workflow-Liste
      // ausblenden. Der optionale Dropdown-Filter (clientFilterId) und der
      // denied-Ausschluss werden über AND kombiniert — ein zweiter clientId-Key
      // im Objektliteral würde den Dropdown-Filter überschreiben.
      // WorkflowInstance.clientId ist NOT NULL → plain notIn.
      const denied = await inaccessibleClientIdsFor(tx, session);
      const baseWhere = {
        status: 'ACTIVE' as const,
        ...(filter === 'mineStart' ? { startedByStaff: staffId } : {}),
        ...(filter === 'mine'
          ? { items: { some: { assigneeStaffId: staffId, doneAt: null } } }
          : {}),
        AND: [
          ...(clientFilterId ? [{ clientId: clientFilterId }] : []),
          ...(denied.length ? [{ clientId: { notIn: denied } }] : []),
        ],
      };
      return Promise.all([
        tx.workflowInstance.findMany({
          where: baseWhere,
          orderBy: { startedAt: 'desc' },
          include: {
            client: { select: { id: true, name: true } },
            items: {
              orderBy: { position: 'asc' },
              select: {
                id: true,
                title: true,
                kind: true,
                doneAt: true,
                startedAt: true,
                dueDate: true,
                assigneeStaffId: true,
              },
            },
          },
          take: 200,
        }),
        tx.client.findMany({
          where: {
            workflowInstances: { some: { status: 'ACTIVE' } },
            ...(denied.length ? { id: { notIn: denied } } : {}),
          },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
      ]);
    },
  );

  const staffName = new Map(allStaff.map((s) => [s.id, s.fullName]));

  // KPI-Box: schnelle Zahlen ganz oben
  const totalCount = instances.length;
  const myItemCount = instances.reduce(
    (sum, inst) =>
      sum + inst.items.filter((it) => it.assigneeStaffId === staffId && !it.doneAt).length,
    0,
  );
  const overdueCount = instances.reduce(
    (sum, inst) =>
      sum +
      inst.items.filter((it) => !it.doneAt && it.dueDate && it.dueDate.getTime() < Date.now())
        .length,
    0,
  );

  function filterLink(value: 'all' | 'mine' | 'mineStart'): string {
    const params = new URLSearchParams();
    if (value !== 'all') params.set('filter', value);
    if (clientFilterId) params.set('clientId', clientFilterId);
    const qs = params.toString();
    return '/staff/workflows' + (qs ? '?' + qs : '');
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-3">
        <h1 className="page-title">
          <Workflow className="h-6 w-6 text-brand-600" />
          Workflows
        </h1>
        <p className="text-muted text-sm">
          Laufende Vorgänge über alle Mandanten. Detail-Sicht pro Mandant via Klick auf den Namen.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <KpiCard label="Laufende Workflows" value={totalCount} icon={Activity} />
        <KpiCard
          label="Mir zugewiesen, offen"
          value={myItemCount}
          icon={UserIcon}
          highlight={myItemCount > 0}
        />
        <KpiCard
          label="Überfällig"
          value={overdueCount}
          icon={AlertCircle}
          highlight={overdueCount > 0}
          tone="red"
        />
      </div>

      {/* Filter-Bar */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <FilterPill href={filterLink('all')} active={filter === 'all'} label="Alle" />
        <FilterPill href={filterLink('mine')} active={filter === 'mine'} label="Mir zugewiesen" />
        <FilterPill
          href={filterLink('mineStart')}
          active={filter === 'mineStart'}
          label="Von mir gestartet"
        />
        {allClients.length > 0 && (
          <form action="/staff/workflows" method="get" className="ml-2 flex items-center gap-1">
            {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
            <select
              name="clientId"
              defaultValue={clientFilterId}
              className="input text-xs py-1 min-w-[12rem]"
            >
              <option value="">— alle Mandanten —</option>
              {allClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary text-xs">
              Filtern
            </button>
            {clientFilterId && (
              <Link href={filterLink(filter)} className="text-xs text-muted hover:underline ml-1">
                ×
              </Link>
            )}
          </form>
        )}
      </div>

      {instances.length === 0 ? (
        <div className="card p-10 text-center">
          <Workflow className="h-10 w-10 text-disabled dark:text-secondary mx-auto mb-3" />
          <p className="text-sm text-disabled mb-3">
            {filter === 'all' && !clientFilterId
              ? 'Keine laufenden Workflows.'
              : 'Keine Treffer für den gewählten Filter.'}
          </p>
          <Link
            href="/staff/workflows/templates"
            className="btn-secondary text-xs inline-flex items-center gap-1.5"
          >
            <Plus className="h-3 w-3" />
            Vorlage wählen und starten
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {instances.map((inst) => {
            const doneItems = inst.items.filter((it) => it.doneAt).length;
            const total = inst.items.length;
            const pct = total > 0 ? Math.round((doneItems / total) * 100) : 0;
            const nextItem = inst.items.find((it) => !it.doneAt);
            const startedByName = staffName.get(inst.startedByStaff) ?? '—';
            const overdue = inst.items.some(
              (it) => !it.doneAt && it.dueDate && it.dueDate.getTime() < Date.now(),
            );
            return (
              <Link
                key={inst.id}
                href={`/staff/clients/${inst.client.id}/workflows`}
                className="card p-4 block hover:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Workflow className="h-3.5 w-3.5 text-disabled" />
                      <span className="font-medium text-primary">{inst.name}</span>
                      <span className="text-sm text-muted">·</span>
                      <span className="text-sm text-secondary">{inst.client.name}</span>
                      {overdue && (
                        <span className="badge-red text-[10px] inline-flex items-center gap-0.5">
                          <AlertCircle className="h-2.5 w-2.5" />
                          überfällig
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-1">
                      gestartet am {fmtDateShort(inst.startedAt)} von {startedByName}
                    </p>
                    {nextItem && (
                      <p className="text-xs text-secondary mt-1">
                        Nächster Schritt: <span className="font-medium">{nextItem.title}</span>
                        {nextItem.assigneeStaffId && (
                          <span className="text-muted">
                            {' '}
                            — zugewiesen an {staffName.get(nextItem.assigneeStaffId) ?? '—'}
                          </span>
                        )}
                        {nextItem.dueDate && (
                          <span className="text-muted">
                            {' '}
                            — fällig {fmtDateShort(nextItem.dueDate)}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted shrink-0 min-w-[6rem]">
                    {doneItems} / {total} erledigt
                    <div className="mt-1 h-1.5 w-24 rounded-full bg-gray-100 overflow-hidden">
                      <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterPill({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-brand-600 text-white'
          : 'inline-flex items-center px-3 py-1 rounded-full text-xs text-secondary bg-gray-100 hover:bg-gray-200'
      }
    >
      {label}
    </Link>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  highlight,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof Activity;
  highlight?: boolean;
  tone?: 'red';
}) {
  const accent =
    tone === 'red'
      ? highlight
        ? 'text-red-700 dark:text-red-400'
        : 'text-disabled'
      : highlight
        ? 'text-brand-700 dark:text-brand-300'
        : 'text-disabled';
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`h-4 w-4 ${accent}`} />
        <p className="text-[11px] font-medium text-muted uppercase tracking-wide truncate">
          {label}
        </p>
      </div>
      <p
        className={`text-2xl font-bold ${tone === 'red' && highlight ? 'text-red-700 dark:text-red-400' : 'text-primary'}`}
      >
        {value}
      </p>
    </div>
  );
}
