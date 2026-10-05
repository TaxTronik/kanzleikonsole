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
//   - ?overduePage=/?upcomingPage=: Seite der Listen in der Listenansicht
// =============================================================================

import type { ReactNode } from 'react';
import { buildMonthGridCells, parseMonth } from '@/lib/tax-calendar';
import Link from 'next/link';
import { SavedViews } from '@/components/saved-views';
import { OffsetPagination } from '@/components/offset-pagination';
import { CalendarMonthGrid, MoreEntries, TaxDeadlinePills } from '@/components/calendar-month-grid';
import { CalendarDays, AlertTriangle, ListChecks, ChevronLeft, ChevronRight } from 'lucide-react';
import type { StaffSession } from '@/server/auth/staff';
import { requireStaffPage } from '@/server/auth/staff-page';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { clientAccessFilter } from '@/server/auth/client-access-filter';
import { loadTaxDeadlineDayGroupsTx } from '@/server/tax-deadlines/day-groups';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { rematerializeAction, markDeadlineDoneAction } from './actions';
import { ActionForm } from '@/components/action-form';
import { fmtDateShort, fmtMonthYear, berlinYmd } from '@/lib/fmt';
import { CalendarModeSwitch } from '@/components/calendar-mode-switch';
import { TAX_DEADLINE_STATUS_LABELS } from '@/lib/domain-labels';
import {
  OVERDUE_PAGE_SIZE,
  UPCOMING_PAGE_SIZE,
  loadDeadlineListTx,
  parseListPage,
  type DeadlineListPages,
} from './_list-data';

interface Search {
  view?: 'month' | 'list';
  scope?: 'mine' | 'all';
  month?: string; // YYYY-MM
  q?: string; // Mandantenname / DATEV-Nr / Addison-Nr (Substring, case-insensitive)
  queued?: string; // '1' nach „Neu berechnen" — Materialisierung läuft im Hintergrund
  overduePage?: string; // Listenansicht: Seite der überfälligen Termine
  upcomingPage?: string; // Listenansicht: Seite der anstehenden Termine
}

export default async function TaxDeadlinesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireStaffPage();
  const sp = await searchParams;
  const view = sp.view === 'list' ? 'list' : 'month';
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const q = (sp.q ?? '').trim();
  const { year, month0 } = parseMonth(sp.month);

  const { staffId } = session.user;

  // Client-Filter aufbauen — scope + Volltext-Suche kombinierbar. Die
  // Sichtbarkeitsregel kommt erst in der Tenant-Tx per AND dazu.
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
  const queued = sp.queued === '1';

  if (view === 'month') {
    return renderMonth(session, year, month0, scope, q, clientWhere, queued);
  }
  return renderList(session, year, month0, scope, q, clientWhere, queued, {
    overdue: parseListPage(sp.overduePage),
    upcoming: parseListPage(sp.upcomingPage),
  });
}

/** Pillen je Tageszelle; der Rest erscheint als „+N weitere". */
const MONTH_CELL_PILLS = 4;

async function renderMonth(
  session: StaffSession,
  year: number,
  month0: number,
  scope: 'mine' | 'all',
  q: string,
  clientFilter: Prisma.ClientWhereInput,
  queued: boolean,
) {
  const { tenantId, staffId } = session.user;
  // Monatsanfang/-ende UTC
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 0, 23, 59, 59, 999));

  // P-20: In der Datenbank pro Tag × Art × Periode × Status zählen (wie der
  // Kanzleikalender) statt alle Termine des Monats samt Mandant zu laden.
  const byDay = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Termine gesperrter
      // Mandanten ausblenden.
      loadTaxDeadlineDayGroupsTx(tx, {
        ...clientAccessFilter(await accessibleClientsWhereFor(tx, session), clientFilter),
        dueDate: { gte: start, lte: end },
      }),
  );

  const currentMonthQs = `${year}-${String(month0 + 1).padStart(2, '0')}`;
  const prevYear = month0 === 0 ? year - 1 : year;
  const prevM = month0 === 0 ? 12 : month0;
  const prevMonthQs = `${prevYear}-${String(prevM).padStart(2, '0')}`;
  const nextYear = month0 === 11 ? year + 1 : year;
  const nextM = month0 === 11 ? 1 : month0 + 2;
  const nextMonthQs = `${nextYear}-${String(nextM).padStart(2, '0')}`;

  // Berlin-Tag (nicht Server-Local): Grid-Zellen sind Kalendertage.
  const cells = buildMonthGridCells(year, month0, berlinYmd(new Date()));

  return (
    <div className="p-4 sm:p-8 max-w-7xl">
      <PageHeader
        view="month"
        scope={scope}
        month={currentMonthQs}
        q={q}
        queued={queued}
        session={session}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <Link
            href={qs({ view: 'month', scope, month: prevMonthQs, q })}
            className="btn-secondary shrink-0 text-xs px-2 py-1"
            aria-label="Vorheriger Monat"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-primary text-center sm:min-w-[200px]">
            {fmtMonthYear(new Date(Date.UTC(year, month0, 15)))}
          </h2>
          <Link
            href={qs({ view: 'month', scope, month: nextMonthQs, q })}
            className="btn-secondary shrink-0 text-xs px-2 py-1"
            aria-label="Nächster Monat"
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

      <CalendarMonthGrid
        cells={cells}
        cellClassName={{
          inMonth: 'bg-surface min-h-[110px] p-1.5 flex flex-col gap-1 text-xs',
          outside: 'bg-surface-page min-h-[110px] p-1.5 flex flex-col gap-1 text-xs text-disabled',
        }}
        todayClassName="self-start font-bold text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded"
        renderDay={(cell) => {
          const groups = byDay.get(cell.dayKey) ?? [];
          return (
            <>
              <TaxDeadlinePills
                groups={groups}
                limit={MONTH_CELL_PILLS}
                doneClassName="cal-pill cal-pill-appointment"
                scope={scope}
                q={q}
              />
              <MoreEntries count={groups.length - MONTH_CELL_PILLS} />
            </>
          );
        }}
      />
    </div>
  );
}

async function renderList(
  session: StaffSession,
  year: number,
  month0: number,
  scope: 'mine' | 'all',
  q: string,
  clientFilter: Prisma.ClientWhereInput,
  queued: boolean,
  requestedPages: DeadlineListPages,
) {
  const { tenantId, staffId } = session.user;
  const currentMonthQs = `${year}-${String(month0 + 1).padStart(2, '0')}`;
  const { overdue, overdueCount, upcoming, upcomingCount, doneCount, pages } =
    await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) =>
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Termine gesperrter
      // Mandanten ausblenden; Regel und Seitenfilter in EINEM `client`-Filter.
      // Kennzahlen und Listen teilen sich genau diesen Filter (F-14).
      loadDeadlineListTx(
        tx,
        clientAccessFilter(await accessibleClientsWhereFor(tx, session), clientFilter),
        requestedPages,
      ),
    );
  // Blättern in einer Liste behält die Seite der anderen Liste bei.
  const pagerQs = (otherParam: 'overduePage' | 'upcomingPage', otherPage: number) => {
    const params = new URLSearchParams({ view: 'list', scope });
    if (q) params.set('q', q);
    if (otherPage > 1) params.set(otherParam, String(otherPage));
    return params;
  };

  return (
    <div className="p-4 sm:p-8 max-w-6xl">
      <PageHeader
        view="list"
        scope={scope}
        month={currentMonthQs}
        q={q}
        queued={queued}
        session={session}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Stat label="Überfällig" value={overdueCount} accent="red" />
        <Stat label="Anstehend" value={upcomingCount} />
        <Stat label="Erledigt (gesamt)" value={doneCount} accent="emerald" />
      </div>

      {overdueCount > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-red-700 mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Überfällig
            <ShownHint shown={overdue.length} total={overdueCount} />
          </h2>
          <DeadlineTable
            rows={overdue}
            footer={
              overdueCount > OVERDUE_PAGE_SIZE && (
                <OffsetPagination
                  basePath="/staff/tax-deadlines"
                  baseQs={pagerQs('upcomingPage', pages.upcoming)}
                  page={pages.overdue}
                  pageSize={OVERDUE_PAGE_SIZE}
                  totalCount={overdueCount}
                  pageParam="overduePage"
                />
              )
            }
          />
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
          Anstehend
          <ShownHint shown={upcoming.length} total={upcomingCount} />
        </h2>
        {upcomingCount === 0 ? (
          <div className="card p-10 text-center">
            <p className="text-sm text-disabled">Keine anstehenden Termine.</p>
          </div>
        ) : (
          <DeadlineTable
            rows={upcoming}
            footer={
              upcomingCount > UPCOMING_PAGE_SIZE && (
                <OffsetPagination
                  basePath="/staff/tax-deadlines"
                  baseQs={pagerQs('overduePage', pages.overdue)}
                  page={pages.upcoming}
                  pageSize={UPCOMING_PAGE_SIZE}
                  totalCount={upcomingCount}
                  pageParam="upcomingPage"
                />
              )
            }
          />
        )}
      </section>
    </div>
  );
}

/** F-14: Hinweis, sobald eine Liste nur einen Ausschnitt der Treffer zeigt. */
function ShownHint({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <span className="text-xs font-normal text-muted">
      {shown.toLocaleString('de-DE')} von {total.toLocaleString('de-DE')} angezeigt
    </span>
  );
}

function PageHeader({
  view,
  scope,
  month,
  q,
  queued,
  session,
}: {
  view: 'month' | 'list';
  scope: 'mine' | 'all';
  month: string;
  q: string;
  queued: boolean;
  session: StaffSession;
}) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-3">
        <div>
          <h1 className="page-title">
            <CalendarDays className="h-6 w-6 text-brand-600" />
            Steuertermine
          </h1>
          <p className="text-muted text-sm">
            {scope === 'mine' ? 'Nur meine Mandanten.' : 'Alle Mandanten der Kanzlei.'}
            {q && (
              <span>
                {' '}
                · Suche: <strong className="text-primary">{q}</strong>
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <CalendarModeSwitch active="tax-deadlines" month={month} />
          <div className="toggle-group">
            <ScopeLink
              active={scope === 'all'}
              scope="all"
              view={view}
              q={q}
              label="Alle Mandanten"
            />
            <ScopeLink
              active={scope === 'mine'}
              scope="mine"
              view={view}
              q={q}
              label="Meine Mandanten"
            />
          </div>
          <div className="toggle-group">
            <ViewLink active={view === 'month'} view="month" scope={scope} q={q} label="Monat" />
            <ViewLink active={view === 'list'} view="list" scope={scope} q={q} label="Liste" />
          </div>
          <ActionForm action={rematerializeAction} errorDisplay="inline">
            {/* Ansicht beibehalten — die Action redirectet mit queued=1 zurück */}
            <input type="hidden" name="view" value={view} />
            <input type="hidden" name="scope" value={scope} />
            <input type="hidden" name="q" value={q} />
            <button type="submit" className="btn-secondary text-xs">
              <ListChecks className="h-4 w-4" />
              Neu berechnen
            </button>
          </ActionForm>
        </div>
      </div>
      {queued && (
        <div className="mb-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-brand-700">
          Berechnung angestoßen — die Steuertermine werden im Hintergrund aktualisiert und
          erscheinen hier in Kürze.
        </div>
      )}
      <form method="get" action="/staff/tax-deadlines" className="flex items-center gap-2">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="scope" value={scope} />
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Mandant suchen — Name, DATEV-Nr. oder Addison-Nr."
          className="input min-w-0 flex-1 text-sm"
          maxLength={120}
        />
        <button type="submit" className="btn-secondary text-xs">
          Filtern
        </button>
        {q && (
          <Link href={qs({ view, scope })} className="btn-secondary text-xs">
            Zurücksetzen
          </Link>
        )}
      </form>
      <div className="mt-3">
        <SavedViews tenantId={session.user.tenantId} staffId={session.user.staffId} />
      </div>
    </div>
  );
}

function ScopeLink({
  active,
  scope,
  view,
  q,
  label,
}: {
  active: boolean;
  scope: 'all' | 'mine';
  view: 'month' | 'list';
  q: string;
  label: string;
}) {
  return (
    <Link
      href={qs({ scope, view, q })}
      className={
        active
          ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
          : 'px-3 py-1.5 text-secondary hover:bg-gray-50'
      }
    >
      {label}
    </Link>
  );
}

function ViewLink({
  active,
  view,
  scope,
  q,
  label,
}: {
  active: boolean;
  view: 'month' | 'list';
  scope: 'all' | 'mine';
  q: string;
  label: string;
}) {
  return (
    <Link
      href={qs({ view, scope, q })}
      className={
        active
          ? 'px-3 py-1.5 bg-brand-600 text-on-brand'
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

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'red' | 'emerald';
}) {
  const tone =
    accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-primary';
  return (
    <div className="card p-4">
      <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${tone}`}>{value.toLocaleString('de-DE')}</p>
    </div>
  );
}

type DeadlineRow = {
  id: string;
  kind: string;
  period: string;
  dueDate: Date;
  status: string;
  requestId: string | null;
  client: { id: string; name: string };
};

function DeadlineTable({
  rows,
  footer,
}: {
  rows: DeadlineRow[];
  /** Seitennavigation unter der Tabelle, innerhalb der Karte (F-14). */
  footer?: ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <div
        className="overflow-x-auto"
        role="region"
        aria-label="Steuertermine"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Horizontale Tabellenspalten müssen per Tastatur erreichbar sein.
        tabIndex={0}
      >
        <DeadlineRows rows={rows} />
      </div>
      {footer}
    </div>
  );
}

function DeadlineRows({ rows }: { rows: DeadlineRow[] }) {
  return (
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
              <Link
                href={`/staff/clients/${d.client.id}`}
                className="text-secondary hover:underline"
              >
                {d.client.name}
              </Link>
            </td>
            <td className="px-6 py-3 font-medium text-primary">
              {SCHEDULE_LABELS[d.kind as keyof typeof SCHEDULE_LABELS] ?? d.kind}
            </td>
            <td className="px-6 py-3 text-secondary">{d.period}</td>
            <td className="px-6 py-3 text-secondary">{fmtDateShort(d.dueDate)}</td>
            <td className="px-6 py-3">
              {d.status === 'OVERDUE' && (
                <span className="badge-red">{TAX_DEADLINE_STATUS_LABELS[d.status]}</span>
              )}
              {d.status === 'REMINDED' && (
                <span className="badge-yellow">{TAX_DEADLINE_STATUS_LABELS[d.status]}</span>
              )}
              {d.status === 'PLANNED' && (
                <span className="badge-gray">{TAX_DEADLINE_STATUS_LABELS[d.status]}</span>
              )}
              {d.status === 'IN_PROGRESS' && (
                <span className="badge-yellow">{TAX_DEADLINE_STATUS_LABELS[d.status]}</span>
              )}
              {d.status === 'SUBMITTED' && (
                <span className="badge-green">{TAX_DEADLINE_STATUS_LABELS[d.status]}</span>
              )}
            </td>
            <td className="px-6 py-3 text-right">
              <div className="flex items-center justify-end gap-2">
                {d.requestId && (
                  <Link
                    href={`/staff/requests/${d.requestId}`}
                    className="text-xs text-brand-700 hover:underline"
                  >
                    Anforderung
                  </Link>
                )}
                <ActionForm
                  action={markDeadlineDoneAction}
                  errorDisplay="inline"
                  className="inline"
                >
                  <input type="hidden" name="id" value={d.id} />
                  <button type="submit" className="text-xs text-muted hover:text-emerald-700">
                    ✓ Erledigt
                  </button>
                </ActionForm>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
