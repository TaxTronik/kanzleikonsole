// =============================================================================
// /staff/tax-deadlines — Steuertermin-Übersicht
//
// Zwei Ansichten via ?view=:
//   - month (Default): Monats-Kalender mit Termin-Pills pro Tag
//   - list:            klassische Liste, gruppiert nach Status
//
// Filter:
//   - ?scope=mine: nur Mandanten, denen ich als Bearbeiter zugeordnet bin
//   - ?scope=all (Default): alle Mandanten
//   - ?month=YYYY-MM: konkreter Monat (Default: aktueller)
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { CalendarDays, AlertTriangle, ListChecks, ChevronLeft, ChevronRight } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { rematerializeAction, markDeadlineDoneAction } from './actions';

const STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Geplant',
  REMINDED: 'Erinnerung versendet',
  IN_PROGRESS: 'In Bearbeitung',
  SUBMITTED: 'Übermittelt',
  DONE: 'Erledigt',
  OVERDUE: 'Überfällig',
  SKIPPED: 'Übersprungen',
};

const dateFmt = new Intl.DateTimeFormat('de-DE');
const monthFmt = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });

interface Search {
  view?: 'month' | 'list';
  scope?: 'mine' | 'all';
  month?: string; // YYYY-MM
}

function parseMonth(s: string | undefined): { year: number; month0: number } {
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    return { year: y!, month0: (m ?? 1) - 1 };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month0: now.getUTCMonth() };
}

export default async function TaxDeadlinesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const sp = await searchParams;
  const view = sp.view === 'list' ? 'list' : 'month';
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const { year, month0 } = parseMonth(sp.month);

  const { tenantId, staffId } = session.user;

  // Bei "scope=mine": Client-IDs vorab filtern
  const clientFilter: Prisma.TaxDeadlineWhereInput = {};
  if (scope === 'mine') {
    clientFilter.client = {
      responsibilities: { some: { staffId } },
    };
  }

  if (view === 'month') {
    return renderMonth(tenantId, staffId, year, month0, scope, clientFilter);
  }
  return renderList(tenantId, staffId, scope, clientFilter);
}

async function renderMonth(
  tenantId: string,
  staffId: string,
  year: number,
  month0: number,
  scope: 'mine' | 'all',
  clientFilter: Prisma.TaxDeadlineWhereInput,
) {
  // Monatsanfang/-ende UTC
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 0, 23, 59, 59, 999));

  const deadlines = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.taxDeadline.findMany({
        where: {
          ...clientFilter,
          dueDate: { gte: start, lte: end },
        },
        orderBy: { dueDate: 'asc' },
        include: { client: { select: { id: true, name: true } } },
      }),
  );

  // Gruppieren nach Tag → dann nach (kind+period) — Steuertermine sind für
  // alle Mandanten gleich; eine Pille pro Termin-Gruppe mit Counter.
  type Group = {
    kind: string;
    period: string;
    total: number;
    open: number; // PLANNED + REMINDED + IN_PROGRESS + OVERDUE + SUBMITTED
    overdue: boolean;
  };
  const byDay = new Map<string, Map<string, Group>>();
  for (const d of deadlines) {
    const dayKey = d.dueDate.toISOString().slice(0, 10);
    const groupKey = `${d.kind}::${d.period}`;
    let dayMap = byDay.get(dayKey);
    if (!dayMap) {
      dayMap = new Map();
      byDay.set(dayKey, dayMap);
    }
    let g = dayMap.get(groupKey);
    if (!g) {
      g = { kind: d.kind, period: d.period, total: 0, open: 0, overdue: false };
      dayMap.set(groupKey, g);
    }
    g.total += 1;
    const isOpen = d.status !== 'DONE' && d.status !== 'SKIPPED';
    if (isOpen) g.open += 1;
    if (d.status === 'OVERDUE') g.overdue = true;
  }

  // Kalender-Grid: Mo-So, beginnt mit dem Montag der Woche, in der der 1. liegt
  const firstDayWeekday = (new Date(Date.UTC(year, month0, 1)).getUTCDay() + 6) % 7; // 0=Mo
  const gridStart = new Date(Date.UTC(year, month0, 1 - firstDayWeekday));
  const cells: Array<{ date: Date; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getTime() + i * 24 * 60 * 60 * 1000);
    cells.push({ date: d, inMonth: d.getUTCMonth() === month0 });
  }

  const prevMonth = `${year}-${String(month0 + 1 - 1).padStart(2, '0')}`;
  const prevYear = month0 === 0 ? year - 1 : year;
  const prevM = month0 === 0 ? 12 : month0;
  const prevMonthQs = `${prevYear}-${String(prevM).padStart(2, '0')}`;
  const nextYear = month0 === 11 ? year + 1 : year;
  const nextM = month0 === 11 ? 1 : month0 + 2;
  const nextMonthQs = `${nextYear}-${String(nextM).padStart(2, '0')}`;
  void prevMonth;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  return (
    <div className="p-8 max-w-7xl">
      <PageHeader view="month" scope={scope} />

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Link
            href={qs({ view: 'month', scope, month: prevMonthQs })}
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h2 className="text-lg font-semibold text-gray-900 min-w-[200px] text-center">
            {monthFmt.format(new Date(Date.UTC(year, month0, 15)))}
          </h2>
          <Link
            href={qs({ view: 'month', scope, month: nextMonthQs })}
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <Link
          href={qs({
            view: 'month',
            scope,
            month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
          })}
          className="btn-secondary text-xs"
        >
          Heute
        </Link>
      </div>

      <div className="card p-2">
        <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-200">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="py-2">
              {weekdayFmt.format(new Date(Date.UTC(2026, 0, 5 + i)))}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px bg-gray-100 mt-px">
          {cells.map((cell, i) => {
            const k = cell.date.toISOString().slice(0, 10);
            const groups = byDay.get(k);
            const groupArr = groups ? Array.from(groups.values()) : [];
            const cellKey = `${cell.date.getUTCFullYear()}-${String(cell.date.getUTCMonth() + 1).padStart(2, '0')}-${String(cell.date.getUTCDate()).padStart(2, '0')}`;
            const isToday = cellKey === todayKey;
            return (
              <div
                key={i}
                className={
                  cell.inMonth
                    ? 'bg-white min-h-[110px] p-1.5 flex flex-col gap-1 text-xs'
                    : 'bg-gray-50 min-h-[110px] p-1.5 flex flex-col gap-1 text-xs text-gray-400'
                }
              >
                <div className={isToday ? 'self-start font-bold text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded' : 'self-start text-gray-700'}>
                  {cell.date.getUTCDate()}
                </div>
                {groupArr.slice(0, 4).map((g) => {
                  const allDone = g.open === 0;
                  const cls = g.overdue
                    ? 'block px-1.5 py-0.5 rounded bg-red-50 text-red-800 truncate hover:bg-red-100'
                    : allDone
                      ? 'block px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 truncate hover:bg-emerald-100'
                      : 'block px-1.5 py-0.5 rounded bg-brand-50 text-brand-800 truncate hover:bg-brand-100';
                  return (
                    <Link
                      key={`${g.kind}-${g.period}`}
                      href={`/staff/tax-deadlines/group?kind=${g.kind}&period=${encodeURIComponent(g.period)}&scope=${scope}`}
                      className={cls}
                      title={`${SCHEDULE_LABELS[g.kind as keyof typeof SCHEDULE_LABELS]} ${g.period} — ${g.open}/${g.total} offen`}
                    >
                      <span className="font-medium">{shortKind(g.kind)}</span>
                      <span className="text-gray-600"> · {g.open}/{g.total}</span>
                    </Link>
                  );
                })}
                {groupArr.length > 4 && (
                  <div className="text-[10px] text-gray-500">+{groupArr.length - 4} weitere</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

async function renderList(
  tenantId: string,
  staffId: string,
  scope: 'mine' | 'all',
  clientFilter: Prisma.TaxDeadlineWhereInput,
) {
  const [overdue, upcoming, done] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.taxDeadline.findMany({
          where: { ...clientFilter, status: 'OVERDUE' },
          orderBy: { dueDate: 'asc' },
          include: { client: { select: { id: true, name: true } } },
          take: 100,
        }),
        tx.taxDeadline.findMany({
          where: { ...clientFilter, status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'SUBMITTED'] } },
          orderBy: { dueDate: 'asc' },
          include: { client: { select: { id: true, name: true } } },
          take: 200,
        }),
        tx.taxDeadline.count({
          where: { ...clientFilter, status: 'DONE', completedAt: { not: null } },
        }),
      ]),
  );

  return (
    <div className="p-8 max-w-6xl">
      <PageHeader view="list" scope={scope} />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Stat label="Überfällig" value={overdue.length} accent="red" />
        <Stat label="Anstehend" value={upcoming.length} />
        <Stat label="Erledigt (gesamt)" value={done} accent="emerald" />
      </div>

      {overdue.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-red-700 mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Überfällig
          </h2>
          <DeadlineTable rows={overdue} />
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Anstehend</h2>
        {upcoming.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-sm text-gray-400">Keine anstehenden Termine.</p>
          </div>
        ) : (
          <DeadlineTable rows={upcoming} />
        )}
      </section>
    </div>
  );
}

function PageHeader({ view, scope }: { view: 'month' | 'list'; scope: 'mine' | 'all' }) {
  return (
    <div className="flex items-end justify-between mb-6">
      <div>
        <Link
          href="/staff/calendar"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-700 mb-1"
        >
          <ChevronLeft className="h-3 w-3" />
          Zurück zum Kanzleikalender
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mb-1 flex items-center gap-2">
          <CalendarDays className="h-6 w-6 text-brand-600" />
          Steuertermine
        </h1>
        <p className="text-gray-500 text-sm">
          {scope === 'mine' ? 'Nur meine Mandanten.' : 'Alle Mandanten der Kanzlei.'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
          <ScopeLink active={scope === 'all'} scope="all" view={view} label="Alle Mandanten" />
          <ScopeLink active={scope === 'mine'} scope="mine" view={view} label="Meine Mandanten" />
        </div>
        <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
          <ViewLink active={view === 'month'} view="month" scope={scope} label="Monat" />
          <ViewLink active={view === 'list'} view="list" scope={scope} label="Liste" />
        </div>
        <form action={rematerializeAction}>
          <button type="submit" className="btn-secondary text-xs">
            <ListChecks className="h-4 w-4" />
            Neu berechnen
          </button>
        </form>
      </div>
    </div>
  );
}

function ScopeLink({
  active, scope, view, label,
}: { active: boolean; scope: 'all' | 'mine'; view: 'month' | 'list'; label: string }) {
  return (
    <Link
      href={qs({ scope, view })}
      className={
        active
          ? 'px-3 py-1.5 bg-brand-600 text-white'
          : 'px-3 py-1.5 text-gray-700 hover:bg-gray-50'
      }
    >
      {label}
    </Link>
  );
}

function ViewLink({
  active, view, scope, label,
}: { active: boolean; view: 'month' | 'list'; scope: 'all' | 'mine'; label: string }) {
  return (
    <Link
      href={qs({ view, scope })}
      className={
        active
          ? 'px-3 py-1.5 bg-brand-600 text-white'
          : 'px-3 py-1.5 text-gray-700 hover:bg-gray-50'
      }
    >
      {label}
    </Link>
  );
}

function qs(p: { view?: string; scope?: string; month?: string }): string {
  const sp = new URLSearchParams();
  if (p.view) sp.set('view', p.view);
  if (p.scope) sp.set('scope', p.scope);
  if (p.month) sp.set('month', p.month);
  const s = sp.toString();
  return s ? `/staff/tax-deadlines?${s}` : '/staff/tax-deadlines';
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'red' | 'emerald' }) {
  const tone =
    accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-gray-900';
  return (
    <div className="card p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${tone}`}>{value}</p>
    </div>
  );
}

function DeadlineTable({
  rows,
}: {
  rows: Array<{
    id: string;
    kind: string;
    period: string;
    dueDate: Date;
    status: string;
    requestId: string | null;
    client: { id: string; name: string };
  }>;
}) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Mandant</th>
            <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Art</th>
            <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Periode</th>
            <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Fällig</th>
            <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
            <th className="text-right px-6 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((d) => (
            <tr key={d.id} className="hover:bg-gray-50">
              <td className="px-6 py-3">
                <Link href={`/staff/clients/${d.client.id}`} className="text-gray-700 hover:underline">
                  {d.client.name}
                </Link>
              </td>
              <td className="px-6 py-3 font-medium text-gray-900">
                {SCHEDULE_LABELS[d.kind as keyof typeof SCHEDULE_LABELS] ?? d.kind}
              </td>
              <td className="px-6 py-3 text-gray-600">{d.period}</td>
              <td className="px-6 py-3 text-gray-700">{dateFmt.format(d.dueDate)}</td>
              <td className="px-6 py-3">
                {d.status === 'OVERDUE' && <span className="badge-red">{STATUS_LABELS[d.status]}</span>}
                {d.status === 'REMINDED' && <span className="badge-yellow">{STATUS_LABELS[d.status]}</span>}
                {d.status === 'PLANNED' && <span className="badge-gray">{STATUS_LABELS[d.status]}</span>}
                {d.status === 'IN_PROGRESS' && <span className="badge-yellow">{STATUS_LABELS[d.status]}</span>}
                {d.status === 'SUBMITTED' && <span className="badge-green">{STATUS_LABELS[d.status]}</span>}
              </td>
              <td className="px-6 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  {d.requestId && (
                    <Link href={`/staff/requests/${d.requestId}`} className="text-xs text-brand-700 hover:underline">
                      Anforderung
                    </Link>
                  )}
                  <form action={markDeadlineDoneAction} className="inline">
                    <input type="hidden" name="id" value={d.id} />
                    <button type="submit" className="text-xs text-gray-500 hover:text-emerald-700">
                      ✓ Erledigt
                    </button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shortKind(k: string): string {
  const m: Record<string, string> = {
    USTA_MONATLICH: 'USt-VA', USTA_QUARTAL: 'USt-VA',
    USTA_JAEHRLICH: 'USt-Jahr', LSTA_MONATLICH: 'LSt',
    LSTA_QUARTAL: 'LSt', LSTA_JAEHRLICH: 'LSt-Jahr',
    EST_VZ: 'ESt-VZ', KST_VZ: 'KSt-VZ', GEWST_VZ: 'GewSt-VZ',
    EST_ERKLAERUNG: 'ESt-Erkl.', KST_ERKLAERUNG: 'KSt-Erkl.', GEWST_ERKLAERUNG: 'GewSt-Erkl.',
  };
  return m[k] ?? k;
}
