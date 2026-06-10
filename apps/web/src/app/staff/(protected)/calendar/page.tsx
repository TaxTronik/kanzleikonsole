// =============================================================================
// /staff/calendar — Kanzleikalender
//
// Zeigt im Monatsraster:
//   - Steuertermine (aus tax_deadline)
//   - Termine (aus appointment)
// Über dem Raster: Liste der offenen Terminanfragen (appointment_request).
//
// Die alte Route /staff/tax-deadlines bleibt unverändert erhalten — wird hier
// als "Nur Steuertermine"-Filter verlinkt.
// =============================================================================

import { redirect } from 'next/navigation';
import { parseMonth, shortKind } from '@/lib/tax-calendar';
import Link from 'next/link';
import { CalendarDays, ChevronLeft, ChevronRight, Inbox, AlertTriangle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { NewAppointmentDialog } from './new-appointment-dialog';
import { RequestDecision, type RequestRow } from './request-decision';
import { fmtMonthYear, fmtTimeShort, fmtWeekdayShort } from '@/lib/fmt';


interface Search {
  month?: string;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const sp = await searchParams;
  const { year, month0 } = parseMonth(sp.month);
  const { tenantId, staffId } = session.user;

  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 0, 23, 59, 59, 999));

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): EIN denied-Set pro
      // Render, an alle mandantengebundenen Queries durchgereicht.
      const denied = await inaccessibleClientIdsFor(tx, session);
      const notDenied = denied.length ? { clientId: { notIn: denied } } : {};
      const [deadlines, appointments, pendingRequests, staffList, clientsList, vacations, absences] = await Promise.all([
        tx.taxDeadline.findMany({
          where: { dueDate: { gte: start, lte: end }, ...notDenied },
          orderBy: { dueDate: 'asc' },
          include: { client: { select: { id: true, name: true } } },
        }),
        tx.appointment.findMany({
          where: {
            startsAt: { lte: end },
            endsAt: { gte: start },
            status: { not: 'CANCELLED' },
            // clientId nullable: Termine ohne Mandantenbezug bleiben sichtbar.
            ...(denied.length
              ? { OR: [{ clientId: null }, { clientId: { notIn: denied } }] }
              : {}),
          },
          orderBy: { startsAt: 'asc' },
          include: {
            owner: { select: { id: true, fullName: true } },
            client: { select: { id: true, name: true } },
          },
        }),
        tx.appointmentRequest.findMany({
          where: { status: 'PENDING', ...notDenied },
          orderBy: { createdAt: 'desc' },
          include: {
            client: { select: { id: true, name: true } },
            createdByContactRel: { select: { fullName: true } },
          },
        }),
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
        tx.client.findMany({
          where: { allowActive: true, ...(denied.length ? { id: { notIn: denied } } : {}) },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
          take: 500,
        }),
        // iter87: Abwesenheiten im Kanzleikalender — nur Name + „Urlaub"/„abw.",
        // ohne Art/Grund (vertraulich, siehe Absence-Modell).
        tx.vacationRequest.findMany({
          where: { status: 'APPROVED', startDate: { lte: end }, endDate: { gte: start } },
          select: { startDate: true, endDate: true, staff: { select: { fullName: true } } },
        }),
        tx.absence.findMany({
          where: { startDate: { lte: end }, OR: [{ endDate: null }, { endDate: { gte: start } }] },
          select: { startDate: true, endDate: true, staff: { select: { fullName: true } } },
        }),
      ]);
      return { deadlines, appointments, pendingRequests, staffList, clientsList, vacations, absences };
    },
  );

  // Gruppieren der Steuertermine pro Tag (wie in der alten Page)
  type DeadlineGroup = { kind: string; period: string; total: number; open: number; overdue: boolean };
  const deadlineByDay = new Map<string, Map<string, DeadlineGroup>>();
  for (const d of data.deadlines) {
    const dayKey = d.dueDate.toISOString().slice(0, 10);
    const groupKey = `${d.kind}::${d.period}`;
    let dayMap = deadlineByDay.get(dayKey);
    if (!dayMap) {
      dayMap = new Map();
      deadlineByDay.set(dayKey, dayMap);
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

  // Termine pro Tag (am Start-Tag eingruppiert; mehrtägige zeigen wir am Anfangstag)
  const apptByDay = new Map<string, Array<typeof data.appointments[number]>>();
  for (const a of data.appointments) {
    const dayKey = a.startsAt.toISOString().slice(0, 10);
    let arr = apptByDay.get(dayKey);
    if (!arr) {
      arr = [];
      apptByDay.set(dayKey, arr);
    }
    arr.push(a);
  }

  // iter87: Abwesenheiten als ganztägige Einträge an JEDEM Tag des Zeitraums
  // (auf den Monat geklammert). Offene Meldungen (ohne Enddatum) laufen bis
  // heute. Anzeige bewusst neutral: „‹Name› Urlaub" bzw. „‹Name› abw.".
  const absenceByDay = new Map<string, string[]>();
  function addAbsenceRange(from: Date, to: Date, label: string) {
    const clampedFrom = from < start ? start : from;
    const clampedTo = to > end ? end : to;
    for (
      let d = new Date(Date.UTC(clampedFrom.getUTCFullYear(), clampedFrom.getUTCMonth(), clampedFrom.getUTCDate()));
      d.getTime() <= clampedTo.getTime();
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    ) {
      const key = d.toISOString().slice(0, 10);
      let arr = absenceByDay.get(key);
      if (!arr) {
        arr = [];
        absenceByDay.set(key, arr);
      }
      arr.push(label);
    }
  }
  const nowDay = new Date();
  for (const v of data.vacations) {
    addAbsenceRange(v.startDate, v.endDate, `${v.staff.fullName} Urlaub`);
  }
  for (const a of data.absences) {
    const until = a.endDate ?? (nowDay > a.startDate ? nowDay : a.startDate);
    addAbsenceRange(a.startDate, until, `${a.staff.fullName} abw.`);
  }

  // Kalendergitter
  const firstDayWeekday = (new Date(Date.UTC(year, month0, 1)).getUTCDay() + 6) % 7;
  const gridStart = new Date(Date.UTC(year, month0, 1 - firstDayWeekday));
  const cells: Array<{ date: Date; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getTime() + i * 24 * 60 * 60 * 1000);
    cells.push({ date: d, inMonth: d.getUTCMonth() === month0 });
  }

  const prevYear = month0 === 0 ? year - 1 : year;
  const prevM = month0 === 0 ? 12 : month0;
  const prevMonthQs = `${prevYear}-${String(prevM).padStart(2, '0')}`;
  const nextYear = month0 === 11 ? year + 1 : year;
  const nextM = month0 === 11 ? 1 : month0 + 2;
  const nextMonthQs = `${nextYear}-${String(nextM).padStart(2, '0')}`;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const requestRows: RequestRow[] = data.pendingRequests.map((r) => ({
    id: r.id,
    subject: r.subject,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    clientName: r.client.name,
    contactName: r.createdByContactRel?.fullName ?? null,
    preferredStaffId: r.preferredStaffId,
    slots: (r.proposedSlots as Array<{ startsAt: string; endsAt: string }>) ?? [],
  }));

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="page-title">
            <CalendarDays className="h-6 w-6 text-brand-600" />
            Kanzleikalender
          </h1>
          <p className="text-muted text-sm">
            Steuertermine, Termine und Abwesenheiten — alle Mandanten der Kanzlei.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/staff/tax-deadlines" className="btn-secondary text-xs">
            Nur Steuertermine
          </Link>
          <NewAppointmentDialog
            staffOptions={data.staffList}
            clientOptions={data.clientsList}
            currentStaffId={staffId}
          />
        </div>
      </div>

      {requestRows.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-default flex items-center gap-2">
            <Inbox className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-medium text-primary">
              Offene Terminanfragen ({requestRows.length})
            </h2>
          </div>
          <ul className="divide-y divide-border-subtle">
            {requestRows.map((r) => (
              <RequestDecision
                key={r.id}
                request={r}
                staffOptions={data.staffList}
                currentStaffId={staffId}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Link
            href={`/staff/calendar?month=${prevMonthQs}`}
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h2 className="text-lg font-semibold text-primary min-w-[220px] text-center">
            {fmtMonthYear(new Date(Date.UTC(year, month0, 15)))}
          </h2>
          <Link
            href={`/staff/calendar?month=${nextMonthQs}`}
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
        <Link
          href={`/staff/calendar?month=${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`}
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
            const dlGroups = deadlineByDay.get(k);
            const dlArr = dlGroups ? Array.from(dlGroups.values()) : [];
            const appts = apptByDay.get(k) ?? [];
            const absentToday = absenceByDay.get(k) ?? [];
            const cellKey = `${cell.date.getUTCFullYear()}-${String(cell.date.getUTCMonth() + 1).padStart(2, '0')}-${String(cell.date.getUTCDate()).padStart(2, '0')}`;
            const isToday = cellKey === todayKey;
            return (
              <div
                key={i}
                className={
                  cell.inMonth
                    ? 'bg-surface min-h-[120px] p-1.5 flex flex-col gap-1 text-xs'
                    : 'bg-surface-page min-h-[120px] p-1.5 flex flex-col gap-1 text-xs text-disabled'
                }
              >
                <div className={isToday ? 'self-start font-bold text-brand-700 bg-brand-50 dark:bg-brand-900/40 dark:text-brand-200 px-1.5 py-0.5 rounded' : 'self-start text-secondary'}>
                  {cell.date.getUTCDate()}
                </div>
                {absentToday.slice(0, 2).map((label, idx) => (
                  <span key={`abs-${idx}`} className="cal-pill cal-pill-absence" title={label}>
                    {label}
                  </span>
                ))}
                {appts.slice(0, 3).map((a) => (
                  <Link
                    key={a.id}
                    href={a.client ? `/staff/clients/${a.client.id}` : '#'}
                    className="cal-pill cal-pill-appointment"
                    title={`${fmtTimeShort(a.startsAt)} – ${fmtTimeShort(a.endsAt)}: ${a.title}${a.client ? ' · ' + a.client.name : ''}`}
                  >
                    <span className="font-medium">{fmtTimeShort(a.startsAt)}</span>
                    {a.client && (
                      <span> · {a.client.name}</span>
                    )}
                    <span className="opacity-70"> · {a.title}</span>
                  </Link>
                ))}
                {dlArr.slice(0, 3).map((g) => {
                  const allDone = g.open === 0;
                  const cls = g.overdue
                    ? 'cal-pill cal-pill-overdue'
                    : allDone
                      ? 'cal-pill cal-pill-done'
                      : 'cal-pill cal-pill-pending';
                  return (
                    <Link
                      key={`${g.kind}-${g.period}`}
                      href={`/staff/tax-deadlines/group?kind=${g.kind}&period=${encodeURIComponent(g.period)}&scope=all`}
                      className={cls}
                      title={`${SCHEDULE_LABELS[g.kind as keyof typeof SCHEDULE_LABELS]} ${g.period} — ${g.open}/${g.total} offen`}
                    >
                      <span className="font-medium">{shortKind(g.kind)}</span>
                      <span className="opacity-70"> · {g.open}/{g.total}</span>
                    </Link>
                  );
                })}
                {(appts.length > 3 || dlArr.length > 3 || absentToday.length > 2) && (
                  <div className="text-[10px] text-muted">
                    +{Math.max(0, appts.length - 3) + Math.max(0, dlArr.length - 3) + Math.max(0, absentToday.length - 2)} weitere
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {data.deadlines.some((d) => d.status === 'OVERDUE') && (
        <p className="text-xs text-red-700 mt-3 inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          Überfällige Steuertermine — siehe „Nur Steuertermine".
        </p>
      )}
    </div>
  );
}
