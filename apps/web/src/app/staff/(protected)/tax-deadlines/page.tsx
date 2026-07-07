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
import { parseMonth, shortKind } from '@/lib/tax-calendar';
import Link from 'next/link';
import { SavedViews } from '@/components/saved-views';
import { CalendarDays, AlertTriangle, ListChecks, ChevronLeft, ChevronRight } from 'lucide-react';
import { staffAuth, type StaffSession } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { rematerializeAction, markDeadlineDoneAction } from './actions';
import { fmtDateShort, fmtMonthYear, fmtWeekdayShort, berlinYmd } from '@/lib/fmt';

const STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Geplant',
  REMINDED: 'Erinnerung versendet',
  IN_PROGRESS: 'In Bearbeitung',
  SUBMITTED: 'Übermittelt',
  DONE: 'Erledigt',
  OVERDUE: 'Überfällig',
  SKIPPED: 'Übersprungen',
};


interface Search {
  view?: 'month' | 'list';
  scope?: 'mine' | 'all';
  month?: string; // YYYY-MM
  q?: string;     // Mandantenname / DATEV-Nr / Addison-Nr (Substring, case-insensitive)
  queued?: string; // '1' nach „Neu berechnen" — Materialisierung läuft im Hintergrund
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
  const q = (sp.q ?? '').trim();
  const { year, month0 } = parseMonth(sp.month);

  const { staffId } = session.user;

  // Client-Filter aufbauen — scope + Volltext-Suche kombinierbar.
  const clientWhere: Prisma.ClientWhereInput = {};
  if (scope === 'mine') {
    clientWhere.responsibilities = { some: { staffId } };
  }
  if (q) {
    clientWhere.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { datevNo: { contains: q, mode: 'insensitive' } },
      { addisonNo: { contains: q, mode: 'insensitive' } },
    ];
  }
  const clientFilter: Prisma.TaxDeadlineWhereInput =
    Object.keys(clientWhere).length > 0 ? { client: clientWhere } : {};

  const queued = sp.queued === '1';

  if (view === 'month') {
    return renderMonth(session, year, month0, scope, q, clientFilter, queued);
  }
  return renderList(session, scope, q, clientFilter, queued);
}

async function renderMonth(
  session: StaffSession,
  year: number,
  month0: number,
  scope: 'mine' | 'all',
  q: string,
  clientFilter: Prisma.TaxDeadlineWhereInput,
  queued: boolean,
) {
  const { tenantId, staffId } = session.user;
  // Monatsanfang/-ende UTC
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 0, 23, 59, 59, 999));

  const deadlines = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Termine gesperrter
      // Mandanten ausblenden.
      const denied = await inaccessibleClientIdsFor(tx, session);
      return tx.taxDeadline.findMany({
        where: {
          ...clientFilter,
          ...(denied.length ? { clientId: { notIn: denied } } : {}),
          dueDate: { gte: start, lte: end },
        },
        orderBy: { dueDate: 'asc' },
        include: { client: { select: { id: true, name: true } } },
      });
    },
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

  // Berlin-Tag (nicht Server-Local): Grid-Zellen sind Kalendertage.
  const todayKey = berlinYmd(new Date());

  return (
    <div className="p-8 max-w-7xl">
      <PageHeader view="month" scope={scope} q={q} queued={queued} />

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Link
            href={qs({ view: 'month', scope, month: prevMonthQs, q })}
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h2 className="text-lg font-semibold text-primary min-w-[200px] text-center">
            {fmtMonthYear(new Date(Date.UTC(year, month0, 15)))}
          </h2>
          <Link
            href={qs({ view: 'month', scope, month: nextMonthQs, q })}
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
            q,
          })}
          className="btn-secondary text-xs"
        >
          Heute
        </Link>
      </div>

      <div className="card p-2">
        <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted uppercase tracking-wide pb-2 border-b border-default">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="py-2">
              {fmtWeekdayShort(new Date(Date.UTC(2026, 0, 5 + i)))}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px mt-px" style={{ backgroundColor: 'rgb(var(--border-default))' }}>
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
                    ? 'bg-surface min-h-[110px] p-1.5 flex flex-col gap-1 text-xs'
                    : 'bg-surface-page min-h-[110px] p-1.5 flex flex-col gap-1 text-xs text-disabled'
                }
              >
                <div className={isToday ? 'self-start font-bold text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded' : 'self-start text-secondary'}>
                  {cell.date.getUTCDate()}
                </div>
                {groupArr.slice(0, 4).map((g) => {
                  const allDone = g.open === 0;
                  const cls = g.overdue
                    ? 'cal-pill cal-pill-overdue'
                    : allDone
                      ? 'cal-pill cal-pill-appointment'
                      : 'cal-pill cal-pill-pending';
                  return (
                    <Link
                      key={`${g.kind}-${g.period}`}
                      href={`/staff/tax-deadlines/group?kind=${g.kind}&period=${encodeURIComponent(g.period)}&scope=${scope}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                      className={cls}
                      title={`${SCHEDULE_LABELS[g.kind as keyof typeof SCHEDULE_LABELS]} ${g.period} — ${g.open}/${g.total} offen`}
                    >
                      <span className="font-medium">{shortKind(g.kind)}</span>
                      <span className="opacity-70"> · {g.open}/{g.total}</span>
                    </Link>
                  );
                })}
                {groupArr.length > 4 && (
                  <div className="text-[10px] text-muted">+{groupArr.length - 4} weitere</div>
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
  session: StaffSession,
  scope: 'mine' | 'all',
  q: string,
  clientFilter: Prisma.TaxDeadlineWhereInput,
  queued: boolean,
) {
  const { tenantId, staffId } = session.user;
  const [overdue, upcoming, done] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Termine gesperrter
      // Mandanten ausblenden.
      const denied = await inaccessibleClientIdsFor(tx, session);
      const notDenied = denied.length ? { clientId: { notIn: denied } } : {};
      return Promise.all([
        tx.taxDeadline.findMany({
          where: { ...clientFilter, ...notDenied, status: 'OVERDUE' },
          orderBy: { dueDate: 'asc' },
          include: { client: { select: { id: true, name: true } } },
          take: 100,
        }),
        tx.taxDeadline.findMany({
          where: { ...clientFilter, ...notDenied, status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'SUBMITTED'] } },
          orderBy: { dueDate: 'asc' },
          include: { client: { select: { id: true, name: true } } },
          take: 200,
        }),
        tx.taxDeadline.count({
          where: { ...clientFilter, ...notDenied, status: 'DONE', completedAt: { not: null } },
        }),
      ]);
    },
  );

  return (
    <div className="p-8 max-w-6xl">
      <PageHeader view="list" scope={scope} q={q} queued={queued} />

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
        <h2 className="text-sm font-semibold text-primary mb-3">Anstehend</h2>
        {upcoming.length === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-sm text-disabled">Keine anstehenden Termine.</p>
          </div>
        ) : (
          <DeadlineTable rows={upcoming} />
        )}
      </section>
    </div>
  );
}

function PageHeader({
  view,
  scope,
  q,
  queued,
}: {
  view: 'month' | 'list';
  scope: 'mine' | 'all';
  q: string;
  queued: boolean;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-end justify-between mb-3">
        <div>
          <Link
            href="/staff/calendar"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-brand-700 mb-1"
          >
            <ChevronLeft className="h-3 w-3" />
            Zurück zum Kanzleikalender
          </Link>
          <h1 className="page-title">
            <CalendarDays className="h-6 w-6 text-brand-600" />
            Steuertermine
          </h1>
          <p className="text-muted text-sm">
            {scope === 'mine' ? 'Nur meine Mandanten.' : 'Alle Mandanten der Kanzlei.'}
            {q && <span> · Suche: <strong className="text-primary">{q}</strong></span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="toggle-group">
            <ScopeLink active={scope === 'all'} scope="all" view={view} q={q} label="Alle Mandanten" />
            <ScopeLink active={scope === 'mine'} scope="mine" view={view} q={q} label="Meine Mandanten" />
          </div>
          <div className="toggle-group">
            <ViewLink active={view === 'month'} view="month" scope={scope} q={q} label="Monat" />
            <ViewLink active={view === 'list'} view="list" scope={scope} q={q} label="Liste" />
          </div>
          <form action={rematerializeAction}>
            {/* Ansicht beibehalten — die Action redirectet mit queued=1 zurück */}
            <input type="hidden" name="view" value={view} />
            <input type="hidden" name="scope" value={scope} />
            <input type="hidden" name="q" value={q} />
            <button type="submit" className="btn-secondary text-xs">
              <ListChecks className="h-4 w-4" />
              Neu berechnen
            </button>
          </form>
        </div>
      </div>
      {queued && (
        <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-700">
          Berechnung angestoßen — die Steuertermine werden im Hintergrund
          aktualisiert und erscheinen hier in Kürze.
        </div>
      )}
      <form
        method="get"
        action="/staff/tax-deadlines"
        className="flex items-center gap-2"
      >
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="scope" value={scope} />
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Mandant suchen — Name, DATEV-Nr. oder Addison-Nr."
          className="input flex-1 text-sm"
          maxLength={120}
        />
        <button type="submit" className="btn-secondary text-xs">Filtern</button>
        {q && (
          <Link href={qs({ view, scope })} className="btn-secondary text-xs">
            Zurücksetzen
          </Link>
        )}
      </form>
      <div className="mt-3">
        <SavedViews />
      </div>
    </div>
  );
}

function ScopeLink({
  active, scope, view, q, label,
}: { active: boolean; scope: 'all' | 'mine'; view: 'month' | 'list'; q: string; label: string }) {
  return (
    <Link
      href={qs({ scope, view, q })}
      className={
        active
          ? 'px-3 py-1.5 bg-brand-600 text-white'
          : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
      }
    >
      {label}
    </Link>
  );
}

function ViewLink({
  active, view, scope, q, label,
}: { active: boolean; view: 'month' | 'list'; scope: 'all' | 'mine'; q: string; label: string }) {
  return (
    <Link
      href={qs({ view, scope, q })}
      className={
        active
          ? 'px-3 py-1.5 bg-brand-600 text-white'
          : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
      }
    >
      {label}
    </Link>
  );
}

function qs(p: { view?: string; scope?: string; month?: string; q?: string }): string {
  const sp = new URLSearchParams();
  if (p.view) sp.set('view', p.view);
  if (p.scope) sp.set('scope', p.scope);
  if (p.month) sp.set('month', p.month);
  if (p.q) sp.set('q', p.q);
  const s = sp.toString();
  return s ? `/staff/tax-deadlines?${s}` : '/staff/tax-deadlines';
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'red' | 'emerald' }) {
  const tone =
    accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-primary';
  return (
    <div className="card p-4">
      <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
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
          <tr className="bg-gray-50 border-b border-default">
            <th className="th">Mandant</th>
            <th className="th">Art</th>
            <th className="th">Periode</th>
            <th className="th">Fällig</th>
            <th className="th">Status</th>
            <th className="text-right px-6 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((d) => (
            <tr key={d.id} className="hover:bg-gray-50">
              <td className="px-6 py-3">
                <Link href={`/staff/clients/${d.client.id}`} className="text-secondary hover:underline">
                  {d.client.name}
                </Link>
              </td>
              <td className="px-6 py-3 font-medium text-primary">
                {SCHEDULE_LABELS[d.kind as keyof typeof SCHEDULE_LABELS] ?? d.kind}
              </td>
              <td className="px-6 py-3 text-secondary">{d.period}</td>
              <td className="px-6 py-3 text-secondary">{fmtDateShort(d.dueDate)}</td>
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
                    <button type="submit" className="text-xs text-muted hover:text-emerald-700">
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

