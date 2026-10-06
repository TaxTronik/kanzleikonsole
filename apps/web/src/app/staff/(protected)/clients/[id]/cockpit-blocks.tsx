// =============================================================================
// Gestreamte Blöcke des Mandanten-Cockpits (Review-Befunde P-07 und K-04).
//
// Jeder Block ist eine async Server-Komponente in einer eigenen <Suspense>-
// Grenze an seiner Grid-Position und wartet nur auf SEIN Daten-Promise
// (startClientCockpitBlocks: ein Loader je Block, gemeinsame Tenant-
// Transaktion, parallel zum Kopf gestartet). Kopf und Navigation erscheinen,
// bevor diese Abfragen fertig sind; jeder Block erscheint, sobald seine Daten
// da sind. Liefert sein Loader `null` (Zugriff fehlt), rendert er nichts.
// =============================================================================

import Link from 'next/link';
import { CalendarDays, Inbox } from 'lucide-react';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import {
  RequestDecision,
  type RequestRow,
} from '@/app/staff/(protected)/calendar/request-decision';
import { berlinYmd, fmtDateShort, fmtDateTimeShort, fmtTimeShort } from '@/lib/fmt';
import { RemindersBlock } from './reminders/reminders-block';
import { BindersBlock } from './binders/binders-block';
import { HandoversBlock } from './handovers/handovers-block';
import { PhoneNotesList } from './phone-notes-list';
import { QuickPhoneNote } from './quick-phone-note';
import {
  CLIENT_REQUESTS_CAP,
  type BindersBlockData,
  type HandoversBlockData,
  type PhoneNotesBlockData,
  type RemindersBlockData,
  type RequestsBlockData,
  type UpcomingBlockData,
  type WorkflowsBlockData,
} from './_data';
import { REQUEST_STATUS_LABELS, PRIORITY_LABELS } from '@/lib/domain-labels';

/** Daten eines Blocks aus seinem eigenen Loader; `null` = Zugriffs-Backstop griff. */
type BlockData<T> = Promise<T | null>;

/** Platzhalter einer Karte, solange ihre Daten noch laden. */
export function CockpitBlockSkeleton({ title }: { title: string }) {
  return (
    <section className="card overflow-hidden" aria-busy="true" aria-label={`${title} wird geladen`}>
      <div className="px-6 py-4 border-b border-default">
        <h2 className="text-sm font-medium text-primary">{title}</h2>
      </div>
      <div className="px-6 py-5 space-y-3">
        <div className="h-4 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      </div>
    </section>
  );
}

type UpcomingRow =
  | {
      kind: 'tax';
      id: string;
      date: Date;
      title: string;
      sub: string;
      overdue: boolean;
    }
  | {
      kind: 'appt';
      id: string;
      date: Date;
      endsAt: Date;
      title: string;
      sub: string;
      status: string;
    };

export async function UpcomingCockpitBlock({
  data: load,
  client,
  showTax,
  showAppts,
  staffId,
  now,
}: {
  data: BlockData<UpcomingBlockData>;
  client: { id: string; name: string };
  showTax: boolean;
  showAppts: boolean;
  staffId: string;
  now: Date;
}) {
  const data = await load;
  if (!data) return null;
  const { taxDeadlines, upcomingAppointments, pendingAppointmentRequests, staffList } = data;
  // Vereinigt Steuertermine (modul-gated) + Appointments (modul-gated).
  const rows: UpcomingRow[] = [];
  if (showTax) {
    for (const d of taxDeadlines) {
      rows.push({
        kind: 'tax',
        id: d.id,
        date: d.dueDate,
        title: SCHEDULE_LABELS[d.kind],
        sub: d.period,
        overdue: d.status === 'OVERDUE',
      });
    }
  }
  if (showAppts) {
    for (const a of upcomingAppointments) {
      rows.push({
        kind: 'appt',
        id: a.id,
        date: a.startsAt,
        endsAt: a.endsAt,
        title: a.title,
        sub: `${a.owner.fullName}${a.location ? ' · ' + a.location : ''}`,
        status: a.status,
      });
    }
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());

  const requestRows: RequestRow[] = (showAppts ? pendingAppointmentRequests : []).map((r) => ({
    id: r.id,
    subject: r.subject,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    clientName: client.name,
    contactName: r.createdByContactRel?.fullName ?? null,
    preferredStaffId: r.preferredStaffId,
    slots: (r.proposedSlots as Array<{ startsAt: string; endsAt: string }>) ?? [],
  }));

  return (
    <div key="upcoming" className="card overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-default">
        <h2 className="text-sm font-medium text-primary flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-disabled" />
          Anstehende Termine
          {requestRows.length > 0 && (
            <span className="badge-yellow text-[10px]">
              {requestRows.length} {requestRows.length === 1 ? 'Anfrage' : 'Anfragen'}
            </span>
          )}
        </h2>
        <Link href="/staff/calendar" className="text-xs text-brand-700 hover:underline">
          Kalender →
        </Link>
      </div>
      {requestRows.length > 0 && (
        <div className="border-b border-default bg-amber-50/40 dark:bg-amber-900/10">
          <p className="px-6 pt-3 text-[11px] uppercase tracking-wide font-medium text-amber-700 dark:text-amber-300">
            Offene Anfragen vom Mandanten
          </p>
          <ul className="divide-y divide-border-subtle">
            {requestRows.map((r) => (
              <RequestDecision
                key={r.id}
                request={r}
                staffOptions={staffList}
                currentStaffId={staffId}
              />
            ))}
          </ul>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-6 py-8 text-sm text-disabled text-center">Keine anstehenden Termine.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {rows.map((r) => (
            <UpcomingRowItem key={`${r.kind}-${r.id}`} row={r} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function UpcomingRowItem({ row: r, now }: { row: UpcomingRow; now: Date }) {
  if (r.kind === 'tax') {
    const daysLeft = Math.ceil((r.date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return (
      <li className="px-6 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-primary truncate inline-flex items-center gap-2">
            {r.title}
            <span className="badge-purple text-[10px]">Steuertermin</span>
          </p>
          <p className="text-xs text-muted">{r.sub}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={r.overdue ? 'text-sm text-red-700 font-medium' : 'text-sm text-primary'}>
            {fmtDateShort(r.date)}
          </p>
          <p className="text-xs text-muted">
            {r.overdue ? `${-daysLeft} Tage überfällig` : `noch ${daysLeft} Tage`}
          </p>
        </div>
      </li>
    );
  }
  return (
    <li className="px-6 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary truncate inline-flex items-center gap-2">
          {r.title}
          {r.status === 'CONFIRMED' && <span className="badge-green text-[10px]">bestätigt</span>}
        </p>
        <p className="text-xs text-muted">{r.sub}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm text-primary">{fmtDateTimeShort(r.date)}</p>
        <p className="text-xs text-muted">– {fmtTimeShort(r.endsAt)}</p>
      </div>
    </li>
  );
}

export async function WorkflowsCockpitBlock({
  data,
  clientId,
  now,
}: {
  data: BlockData<WorkflowsBlockData>;
  clientId: string;
  now: Date;
}) {
  const workflowInstances = await data;
  if (!workflowInstances) return null;
  return (
    <div key="workflows" className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-sm font-medium text-primary">Aktive Workflows</h2>
        <Link
          href={`/staff/clients/${clientId}/workflows`}
          className="text-xs text-brand-700 hover:underline"
        >
          Alle ansehen →
        </Link>
      </div>
      {workflowInstances.length === 0 ? (
        <p className="px-6 py-6 text-sm text-disabled text-center">
          Keine laufenden Workflows.{' '}
          <Link
            href={`/staff/clients/${clientId}/workflows`}
            className="text-brand-700 hover:underline"
          >
            Workflow starten →
          </Link>
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {workflowInstances.map((inst) => {
            const total = inst.items.length;
            const done = inst.items.filter((it) => it.doneAt).length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const overdue = inst.items.some(
              (it) => !it.doneAt && it.dueDate && it.dueDate.getTime() < now.getTime(),
            );
            return (
              <li key={inst.id}>
                <Link
                  href={`/staff/clients/${clientId}/workflows/${inst.id}`}
                  className="block px-6 py-3 hover:bg-gray-50"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-primary truncate inline-flex items-center gap-2">
                        {inst.name}
                        {overdue && <span className="badge-red text-[10px]">überfällig</span>}
                      </p>
                      <p className="text-[11px] text-muted">
                        gestartet am {fmtDateShort(inst.startedAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="text-[11px] text-muted">
                        {done}/{total}
                      </span>
                      <div className="mt-0.5 h-1 w-20 rounded-full bg-gray-100 overflow-hidden">
                        <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export async function RemindersCockpitBlock({
  data: load,
  clientId,
  staffId,
  isAdmin,
}: {
  data: BlockData<RemindersBlockData>;
  clientId: string;
  staffId: string;
  isAdmin: boolean;
}) {
  const data = await load;
  if (!data) return null;
  const { reminders, staffList } = data;
  const staffNameById = new Map(staffList.map((s) => [s.id, s.fullName]));
  return (
    <RemindersBlock
      key={`reminders:${clientId}`}
      clientId={clientId}
      currentStaffId={staffId}
      canSteerAll={isAdmin}
      staffOptions={staffList}
      initial={reminders.map((r) => ({
        id: r.id,
        ticketNumber: r.ticketNumber,
        archivedAt: r.archivedAt?.toISOString() ?? null,
        canArchive:
          !r.archivedAt &&
          Boolean(r.doneAt && r.doneByStaff) &&
          (r.createdByStaff === staffId || isAdmin),
        dueDate: r.dueDate.toISOString(),
        subject: r.subject,
        notes: r.notes,
        doneAt: r.doneAt ? r.doneAt.toISOString() : null,
        assigneeNames: r.assignees
          .map((a) => staffNameById.get(a.staffId))
          .filter((n): n is string => Boolean(n)),
        researchMarkingId: r.riskMarkings[0]?.id ?? null,
        researchAnalysisId: r.riskMarkings[0]?.analysisId ?? null,
        createdByStaff: r.createdByStaff,
        createdByName: staffNameById.get(r.createdByStaff) ?? null,
        assigneeStaffIds: r.assignees.map((a) => a.staffId),
        priority: r.priority,
      }))}
    />
  );
}

export async function BindersCockpitBlock({
  data,
  clientId,
}: {
  data: BlockData<BindersBlockData>;
  clientId: string;
}) {
  const binders = await data;
  if (!binders) return null;
  return (
    <BindersBlock
      key="binders"
      clientId={clientId}
      initial={binders.map((b) => ({
        id: b.id,
        label: b.label,
        contents: b.contents,
        status: b.status,
        expectedReturnAt: b.expectedReturnAt ? b.expectedReturnAt.toISOString() : null,
        sentAt: b.sentAt ? b.sentAt.toISOString() : null,
        returnedAt: b.returnedAt ? b.returnedAt.toISOString() : null,
      }))}
    />
  );
}

export async function HandoversCockpitBlock({
  data,
  clientId,
}: {
  data: BlockData<HandoversBlockData>;
  clientId: string;
}) {
  const handovers = await data;
  if (!handovers) return null;
  return (
    <HandoversBlock
      key="handovers"
      clientId={clientId}
      initial={handovers.map((h) => ({
        id: h.id,
        label: h.label,
        contents: h.contents,
        status: h.status,
        receivedAt: h.receivedAt.toISOString(),
        startedAt: h.startedAt ? h.startedAt.toISOString() : null,
        readyAt: h.readyAt ? h.readyAt.toISOString() : null,
        pickedUpAt: h.pickedUpAt ? h.pickedUpAt.toISOString() : null,
        notifiedContactEmail: h.notifiedContactEmail,
        mailDelivery: h.mailDelivery,
      }))}
    />
  );
}

export async function PhoneNotesCockpitBlock({
  data: load,
  clientId,
  contacts,
  staffId,
}: {
  data: BlockData<PhoneNotesBlockData>;
  clientId: string;
  contacts: Array<{ fullName: string; phone: string | null }>;
  staffId: string;
}) {
  const data = await load;
  if (!data) return null;
  const { phoneNotes, staffList } = data;
  return (
    <div key="phone_notes" className="card overflow-hidden">
      <QuickPhoneNote
        clientId={clientId}
        contacts={contacts}
        staff={staffList}
        currentStaffId={staffId}
      />
      <PhoneNotesList
        currentStaffId={staffId}
        staffOptions={staffList}
        todayYmd={berlinYmd(new Date())}
        notes={phoneNotes.map((p) => ({
          id: p.id,
          subject: p.subject,
          callerName: p.callerName,
          callerPhone: p.callerPhone,
          body: p.body,
          forwardToStaff: p.forwardToStaff,
          doneAt: p.doneAt ? p.doneAt.toISOString() : null,
          readAt: p.readAt ? p.readAt.toISOString() : null,
          createdAt: p.createdAt.toISOString(),
          takenByStaff: p.takenByStaff,
          clientId: p.clientId,
          reminders: p.reminders.map((reminder) => ({
            id: reminder.id,
            subject: reminder.subject,
            dueDate: reminder.dueDate.toISOString(),
            doneAt: reminder.doneAt?.toISOString() ?? null,
          })),
        }))}
      />
    </div>
  );
}

export async function RequestsCockpitBlock({
  data,
  client,
}: {
  data: BlockData<RequestsBlockData>;
  client: { id: string; name: string };
}) {
  const requests = await data;
  if (!requests) return null;
  return (
    <div key="requests" className="card overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-default">
        <h2 className="text-sm font-medium text-primary">
          Anforderungen
          {requests.length === CLIENT_REQUESTS_CAP && (
            <span className="ml-2 text-xs font-normal text-muted">
              zeige die neuesten {CLIENT_REQUESTS_CAP}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-3">
          <Link
            href={`/staff/requests?q=${encodeURIComponent(client.name)}`}
            className="text-xs text-brand-700 hover:underline"
          >
            Alle Anforderungen →
          </Link>
        </div>
      </div>
      {requests.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <Inbox className="h-10 w-10 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">Noch keine Anforderungen.</p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="th">Titel</th>
              <th className="th">Status</th>
              <th className="th">Priorität</th>
              <th className="th">Fällig</th>
              <th className="th">Letzte Antwort</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {requests.map((req) => (
              <RequestRowItem key={req.id} request={req} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RequestRowItem({ request: req }: { request: RequestsBlockData[number] }) {
  const last = req.responses[0];
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 font-medium text-primary">
        <Link href={`/staff/requests/${req.id}`} className="hover:underline">
          {req.title}
        </Link>
      </td>
      <td className="px-6 py-4">
        {req.status === 'OPEN' && (
          <span className="badge-yellow">{REQUEST_STATUS_LABELS[req.status]}</span>
        )}
        {req.status === 'IN_PROGRESS' && (
          <span className="badge-yellow">{REQUEST_STATUS_LABELS[req.status]}</span>
        )}
        {req.status === 'RESPONDED' && (
          <span className="badge-green">{REQUEST_STATUS_LABELS[req.status]}</span>
        )}
        {req.status === 'CLOSED' && (
          <span className="badge-gray">{REQUEST_STATUS_LABELS[req.status]}</span>
        )}
        {req.status === 'CANCELLED' && (
          <span className="badge-gray">{REQUEST_STATUS_LABELS[req.status]}</span>
        )}
      </td>
      <td className="px-6 py-4 text-secondary">
        {req.priority === 'URGENT' && (
          <span className="badge-red">{PRIORITY_LABELS[req.priority]}</span>
        )}
        {req.priority === 'HIGH' && (
          <span className="badge-yellow">{PRIORITY_LABELS[req.priority]}</span>
        )}
        {req.priority === 'NORMAL' && PRIORITY_LABELS[req.priority]}
        {req.priority === 'LOW' && (
          <span className="text-disabled">{PRIORITY_LABELS[req.priority]}</span>
        )}
      </td>
      <td className="px-6 py-4 text-secondary">{req.dueAt ? fmtDateShort(req.dueAt) : '—'}</td>
      <td className="px-6 py-4 text-secondary">{last ? fmtDateShort(last.createdAt) : '—'}</td>
    </tr>
  );
}
