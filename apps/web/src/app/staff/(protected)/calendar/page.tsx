// =============================================================================
// /staff/calendar — Kanzleikalender
//
// Zeigt im Monatsraster:
//   - Steuertermine (aus tax_deadline) — Modul taxNotices
//   - Termine (aus appointment) — Modul appointments; die Pille öffnet
//     „Termin bearbeiten" mit „Termin absagen", abgesagte bleiben durchgestrichen
//   - Abwesenheiten (ohne Modul)
// Über dem Raster: Liste der offenen Terminanfragen (appointment_request) —
// Modul appointments.
// Registry-Bereich officeCalendar: nutzbar, sobald eines der beiden Module
// aktiv ist; Inhalte des inaktiven Moduls werden weder geladen noch gezeigt.
//
// Die fokussierte Route /staff/tax-deadlines bleibt über denselben
// Ansichts-Schalter in beiden Kalendern direkt erreichbar.
// =============================================================================

import { berlinMonthBoundsUtc, buildMonthGridCells, parseMonth } from '@/lib/tax-calendar';
import Link from 'next/link';
import { CalendarDays, ChevronLeft, ChevronRight, Inbox, AlertTriangle } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { requireModulePage } from '@/server/settings/module-page';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { clientAccessFilter, optionalClientAccessFilter } from '@/server/auth/client-access-filter';
import { loadTaxDeadlineDayGroupsTx } from '@/server/tax-deadlines/day-groups';
import { loadMailDeliveryTx } from '@/server/mail/delivery-status';
import { withTenantContext } from '@taxtronik/db';
import { NewAppointmentDialog } from './new-appointment-dialog';
import { AppointmentPills } from './appointment-pills';
import { RequestDecision, type RequestRow } from './request-decision';
import { DecidedRequests } from './decided-requests';
import { fmtMonthYear, berlinYmd } from '@/lib/fmt';
import { CalendarModeSwitch } from '@/components/calendar-mode-switch';
import { CalendarMonthGrid, MoreEntries, TaxDeadlinePills } from '@/components/calendar-month-grid';

interface Search {
  month?: string;
}

const NO_TAX_DEADLINES: Awaited<ReturnType<typeof loadTaxDeadlineDayGroupsTx>> = new Map();
/** C4: Entschiedene Terminanfragen bleiben so lange mit dem Zustellstatus ihrer Mail sichtbar. */
const DECIDED_REQUEST_DAYS = 14;

function calendarDescription(showTax: boolean, showAppointments: boolean): string {
  const parts = [
    ...(showTax ? ['Steuertermine'] : []),
    ...(showAppointments ? ['Termine'] : []),
    'Abwesenheiten',
  ];
  return `${parts.slice(0, -1).join(', ')} und ${parts.at(-1)} — alle Mandanten der Kanzlei.`;
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffPage();
  const modules = await requireModulePage('staff', 'officeCalendar');
  const showTax = modules.taxNotices;
  const showAppointments = modules.appointments;

  const sp = await searchParams;
  const { year, month0 } = parseMonth(sp.month);
  const { tenantId, staffId } = session.user;

  // @db.Date-Felder sind als UTC-Kalendertage kodiert. Appointment-Zeitpunkte
  // sind dagegen echte Instants und brauchen DST-korrekte Berlin-Grenzen.
  const dateStart = new Date(Date.UTC(year, month0, 1));
  const dateEnd = new Date(Date.UTC(year, month0 + 1, 0, 23, 59, 59, 999));
  const { start: appointmentStart, endExclusive: appointmentEndExclusive } = berlinMonthBoundsUtc(
    year,
    month0,
  );

  // C4: Entscheidungen dieses Zeitraums bleiben mit ihrem Zustellstatus sichtbar.
  const decidedSince = new Date(new Date().getTime() - DECIDED_REQUEST_DAYS * 86_400_000);

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): EINE Sichtbarkeitsregel
      // pro Render, als Relationsfilter an alle mandantengebundenen Queries.
      const clientAccess = await accessibleClientsWhereFor(tx, session);
      const viaVisibleClient = clientAccessFilter(clientAccess);
      const [
        deadlines,
        appointments,
        pendingRequests,
        decidedRequests,
        staffList,
        // Keine Mandantenliste mehr: der Termindialog sucht serverseitig.
        vacations,
        absences,
      ] = await Promise.all([
        // P-20: dieselbe DB-Aggregation wie /staff/tax-deadlines (Monatsansicht).
        showTax
          ? loadTaxDeadlineDayGroupsTx(tx, {
              dueDate: { gte: dateStart, lte: dateEnd },
              ...viaVisibleClient,
            })
          : Promise.resolve(NO_TAX_DEADLINES),
        showAppointments
          ? tx.appointment.findMany({
              where: {
                startsAt: { lt: appointmentEndExclusive },
                endsAt: { gte: appointmentStart },
                // C1: Abgesagte Termine bleiben hier (und nur hier) als abgesagt
                // sichtbar; Übersichten, Portal und iCal-Feed blenden sie aus.
                // clientId nullable: Termine ohne Mandantenbezug bleiben sichtbar.
                ...optionalClientAccessFilter(clientAccess),
              },
              orderBy: { startsAt: 'asc' },
              include: {
                owner: { select: { id: true, fullName: true } },
                client: { select: { id: true, name: true } },
              },
            })
          : Promise.resolve([]),
        showAppointments
          ? tx.appointmentRequest.findMany({
              where: { status: 'PENDING', ...viaVisibleClient },
              orderBy: { createdAt: 'desc' },
              include: {
                client: { select: { id: true, name: true } },
                createdByContactRel: { select: { fullName: true } },
              },
            })
          : Promise.resolve([]),
        // C4: Nach der Entscheidung verschwindet die Anfrage aus der offenen
        // Liste; der Zustellstatus der Bestätigungs-/Absagemail bleibt hier.
        showAppointments
          ? tx.appointmentRequest.findMany({
              where: {
                status: { in: ['ACCEPTED', 'REJECTED'] },
                decidedAt: { gte: decidedSince },
                ...viaVisibleClient,
              },
              orderBy: [{ decidedAt: 'desc' }, { id: 'asc' }],
              take: 20,
              select: {
                id: true,
                subject: true,
                status: true,
                decidedAt: true,
                client: { select: { name: true } },
              },
            })
          : Promise.resolve([]),
        // Bearbeiterauswahl nur für Terminanlage, -bearbeitung und Terminanfragen.
        showAppointments
          ? tx.staffUser.findMany({
              where: { active: true },
              orderBy: { fullName: 'asc' },
              select: { id: true, fullName: true },
            })
          : Promise.resolve([]),
        // iter87: Abwesenheiten im Kanzleikalender — nur Name + „Urlaub"/„abw.",
        // ohne Art/Grund (vertraulich, siehe Absence-Modell).
        tx.vacationRequest.findMany({
          // Nur aktive Mitarbeiter — sonst tauchen Namen deaktivierter Konten im
          // Kanzleikalender auf (der Wandkalender filtert über staffList genauso).
          where: {
            status: 'APPROVED',
            staff: { active: true },
            startDate: { lte: dateEnd },
            endDate: { gte: dateStart },
          },
          select: { startDate: true, endDate: true, staff: { select: { fullName: true } } },
        }),
        tx.absence.findMany({
          where: {
            staff: { active: true },
            startDate: { lte: dateEnd },
            OR: [{ endDate: null }, { endDate: { gte: dateStart } }],
          },
          select: { startDate: true, endDate: true, staff: { select: { fullName: true } } },
        }),
      ]);
      const decisionMail = await loadMailDeliveryTx(tx, {
        resourceType: 'appointment_request',
        resourceIds: decidedRequests.map((request) => request.id),
      });
      return {
        deadlines,
        appointments,
        pendingRequests,
        decidedRequests: decidedRequests.map((request) => ({
          id: request.id,
          subject: request.subject,
          clientName: request.client.name,
          status: request.status,
          decidedAt: request.decidedAt,
          mail: decisionMail.get(request.id) ?? [],
        })),
        staffList,
        vacations,
        absences,
      };
    },
  );

  // Steuertermine pro Tag, bereits nach Art + Periode gruppiert (P-20).
  const deadlineByDay = data.deadlines;
  const anyOverdue = [...deadlineByDay.values()].some((groups) => groups.some((g) => g.overdue));

  // Termine pro Tag (am Start-Tag eingruppiert; mehrtägige zeigen wir am Anfangstag)
  const apptByDay = new Map<string, Array<(typeof data.appointments)[number]>>();
  for (const a of data.appointments) {
    // Berlin-Kalendertag (nicht UTC): startsAt ist ein echter Instant; die Pille
    // zeigt die Berlin-Uhrzeit, also muss die Zelle auch der Berlin-Tag sein.
    const dayKey = berlinYmd(a.startsAt);
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
    const clampedFrom = from < dateStart ? dateStart : from;
    const clampedTo = to > dateEnd ? dateEnd : to;
    for (
      let d = new Date(
        Date.UTC(clampedFrom.getUTCFullYear(), clampedFrom.getUTCMonth(), clampedFrom.getUTCDate()),
      );
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

  const prevYear = month0 === 0 ? year - 1 : year;
  const prevM = month0 === 0 ? 12 : month0;
  const prevMonthQs = `${prevYear}-${String(prevM).padStart(2, '0')}`;
  const nextYear = month0 === 11 ? year + 1 : year;
  const nextM = month0 === 11 ? 1 : month0 + 2;
  const nextMonthQs = `${nextYear}-${String(nextM).padStart(2, '0')}`;
  const currentMonthQs = `${year}-${String(month0 + 1).padStart(2, '0')}`;

  // Berlin-Tag (nicht Server-Local): der Grid-Schlüssel ist der Kalendertag,
  // und „heute" muss in derselben Zeitzone bestimmt werden wie die Zellen.
  const cells = buildMonthGridCells(year, month0, berlinYmd(new Date()));

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
    <div className="p-4 sm:p-8 max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="page-title">
            <CalendarDays className="h-6 w-6 text-brand-600" />
            Kanzleikalender
          </h1>
          <p className="text-muted text-sm">{calendarDescription(showTax, showAppointments)}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showTax && <CalendarModeSwitch active="calendar" month={currentMonthQs} />}
          {showAppointments && (
            <NewAppointmentDialog staffOptions={data.staffList} currentStaffId={staffId} />
          )}
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

      <DecidedRequests requests={data.decidedRequests} days={DECIDED_REQUEST_DAYS} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/staff/calendar?month=${prevMonthQs}`}
            aria-label="Vorheriger Monat"
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          </Link>
          <h2 className="min-w-0 text-center text-lg font-semibold text-primary sm:min-w-[220px]">
            {fmtMonthYear(new Date(Date.UTC(year, month0, 15)))}
          </h2>
          <Link
            href={`/staff/calendar?month=${nextMonthQs}`}
            aria-label="Nächster Monat"
            className="btn-secondary text-xs px-2 py-1"
          >
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
        <Link
          href={`/staff/calendar?month=${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`}
          className="btn-secondary text-xs"
        >
          Heute
        </Link>
      </div>

      <CalendarMonthGrid
        cells={cells}
        cellClassName={{
          inMonth: 'bg-surface min-h-[120px] p-1.5 flex flex-col gap-1 text-xs',
          outside: 'bg-surface-page min-h-[120px] p-1.5 flex flex-col gap-1 text-xs text-disabled',
        }}
        todayClassName="self-start font-bold text-brand-700 bg-brand-50 dark:bg-brand-900/40 dark:text-brand-200 px-1.5 py-0.5 rounded"
        renderDay={(cell) => {
          const dlArr = deadlineByDay.get(cell.dayKey) ?? [];
          const appts = apptByDay.get(cell.dayKey) ?? [];
          const absentToday = absenceByDay.get(cell.dayKey) ?? [];
          return (
            <>
              {absentToday.slice(0, 2).map((label, idx) => (
                <span key={`abs-${idx}`} className="cal-pill cal-pill-absence" title={label}>
                  {label}
                </span>
              ))}
              {/* C1: Pille öffnet „Termin bearbeiten"; die Mandantenakte ist dort verlinkt. */}
              <AppointmentPills appointments={appts} staffOptions={data.staffList} limit={3} />
              <TaxDeadlinePills
                groups={dlArr}
                limit={3}
                doneClassName="cal-pill cal-pill-done"
                scope="all"
              />
              <MoreEntries
                count={
                  Math.max(0, appts.length - 3) +
                  Math.max(0, dlArr.length - 3) +
                  Math.max(0, absentToday.length - 2)
                }
              />
            </>
          );
        }}
      />

      {anyOverdue && (
        <p className="text-xs text-red-700 mt-3 inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          Überfällige Steuertermine — siehe „Nur Steuertermine".
        </p>
      )}
    </div>
  );
}
