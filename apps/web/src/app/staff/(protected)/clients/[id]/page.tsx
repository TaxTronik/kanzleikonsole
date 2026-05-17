import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Inbox, Plus, Archive, CalendarDays, Wand2 } from 'lucide-react';
import { computeOnboardingStatus, resumeStep } from '@/server/onboarding/status';
import { readModules } from '@/server/settings/modules';
import { readClientLayout, type ClientBlockKey } from '@/server/settings/client-layout';
import { CockpitGrid } from './cockpit-grid';
import { RequestDecision, type RequestRow } from '@/app/staff/(protected)/calendar/request-decision';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { DocumentsManager } from '@/components/documents-manager';
import { ClientContactsPanel } from '@/components/client-contacts-panel';
import { QuickPhoneNote } from './quick-phone-note';
import { RemindersBlock } from './reminders/reminders-block';
import { BindersBlock } from './binders/binders-block';
import { HandoversBlock } from './handovers/handovers-block';
import { PhoneNotesList } from './phone-notes-list';

const kindLabels: Record<string, string> = {
  NATPERS: 'Natürliche Person',
  JURPERS: 'Juristische Person',
  PERSGES: 'Personengesellschaft',
};

const dateFmt = new Intl.DateTimeFormat('de-DE');
const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function formatCustomValue(type: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-gray-400 font-normal">—</span>;
  }
  if (type === 'CHECKBOX') return value ? 'Ja' : 'Nein';
  if (type === 'MONEY' && typeof value === 'number') return eurFmt.format(value);
  if (type === 'NUMBER' && typeof value === 'number') return value.toLocaleString('de-DE');
  if (type === 'DATE' && typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : dateFmt.format(d);
  }
  if (type === 'URL' && typeof value === 'string') {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
        {value}
      </a>
    );
  }
  return String(value);
}

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  const { tenantId, staffId } = session.user;
  const settingsCtx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [modules, clientLayout] = await Promise.all([
    readModules(settingsCtx),
    readClientLayout(settingsCtx),
  ]);

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const c = await tx.client.findUnique({
        where: { id },
        include: {
          documents: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
          },
          documentFolders: {
            select: { id: true, name: true, parentId: true },
            orderBy: { name: 'asc' },
          },
          requests: {
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
            include: { responses: { take: 1, orderBy: { createdAt: 'desc' } } },
          },
          contacts: { where: { active: true }, orderBy: { fullName: 'asc' } },
          gwgChecks: { orderBy: { createdAt: 'desc' }, take: 1 },
          responsibilities: {
            include: { staff: { select: { id: true, fullName: true } } },
          },
          _count: {
            select: {
              poas: true,
              gwgInvites: true,
              gwgChecks: true,
            },
          },
        },
      });
      if (!c) return null;
      const [phoneNotes, taxDeadlines, pendingChangeRequests, customDefs, customValues, staffList, workflowInstances, reminders, binders, upcomingAppointments, pendingAppointmentRequests, handovers, managerDocs] = await Promise.all([
        tx.phoneNote.findMany({
          where: { clientId: id },
          orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
          take: 20,
        }),
        tx.taxDeadline.findMany({
          where: {
            clientId: id,
            status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
          },
          orderBy: { dueDate: 'asc' },
          take: 12,
        }),
        tx.clientMasterChangeRequest.count({
          where: { clientId: id, status: 'PENDING' },
        }),
        tx.clientCustomFieldDef.findMany({
          where: { active: true },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
        tx.clientCustomFieldValue.findMany({
          where: { clientId: id },
        }),
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
        tx.workflowInstance.findMany({
          where: { clientId: id, status: 'ACTIVE' },
          orderBy: { startedAt: 'desc' },
          take: 6,
          include: {
            items: { select: { id: true, doneAt: true, dueDate: true } },
          },
        }),
        tx.clientReminder.findMany({
          where: { clientId: id },
          orderBy: [{ doneAt: 'asc' }, { dueDate: 'asc' }],
          take: 50,
        }),
        tx.pendingBinder.findMany({
          where: { clientId: id },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          take: 50,
        }),
        tx.appointment.findMany({
          where: { clientId: id, status: { not: 'CANCELLED' }, endsAt: { gte: new Date() } },
          orderBy: { startsAt: 'asc' },
          take: 5,
          select: {
            id: true, title: true, startsAt: true, endsAt: true, location: true, status: true,
            owner: { select: { id: true, fullName: true } },
          },
        }),
        tx.appointmentRequest.findMany({
          where: { clientId: id, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true, subject: true, notes: true, createdAt: true,
            preferredStaffId: true, proposedSlots: true,
            createdByContactRel: { select: { fullName: true } },
          },
        }),
        tx.clientHandover.findMany({
          where: { clientId: id },
          orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
          take: 50,
        }),
        // Für den DocumentsManager: alle Dokumente des Mandanten INKL.
        // soft-gelöschter (der Manager hat eine eigene Gelöscht-Ansicht).
        tx.document.findMany({
          where: { clientId: id },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            classification: true,
            documentTypeId: true,
            documentType: { select: { name: true, tier: true } },
            createdAt: true,
            folderId: true,
            deletedAt: true,
            sharedWithClientAt: true,
            versions: {
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { sizeBytes: true },
            },
          },
        }),
      ]);
      return { client: c, phoneNotes, taxDeadlines, pendingChangeRequests, customDefs, customValues, staffList, workflowInstances, reminders, binders, upcomingAppointments, pendingAppointmentRequests, handovers, managerDocs };
    },
  );

  if (!data) notFound();
  const { client, phoneNotes, taxDeadlines, pendingChangeRequests, customDefs, customValues, staffList, workflowInstances, reminders, binders, upcomingAppointments, pendingAppointmentRequests, handovers, managerDocs } = data;
  const staffNameById = new Map(staffList.map((s) => [s.id, s.fullName]));

  const customDefsForKind = customDefs.filter(
    (d) => d.appliesTo.length === 0 || d.appliesTo.includes(client.kind),
  );
  const customValuesById = new Map(customValues.map((v) => [v.fieldId, v.value]));

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

  const classificationLabels: Record<string, string> = {
    GOBD_INVOICE: 'GoBD Rechnung',
    GOBD_CONTRACT: 'GoBD Vertrag',
    GOBD_TAX: 'GoBD Steuer',
    GWG_EVIDENCE: 'GwG Nachweis',
    PERSONNEL: 'Personal',
    STAFF_PRIVATE: 'Intern',
    GENERAL: 'Allgemein',
  };

  return (
    <div className="p-8">
      <div className="flex items-start gap-4 mb-8">
        <Link href="/staff/clients" className="text-gray-400 hover:text-gray-600 mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">{client.name}</h1>
            {client.allowActive ? (
              <span className="badge-green">Aktiv</span>
            ) : (
              <span className="badge-yellow">GwG ausstehend</span>
            )}
          </div>
          <p className="text-gray-500 text-sm">
            {kindLabels[client.kind] ?? client.kind}
            {client.datevNo ? ` · DATEV ${client.datevNo}` : ''}
            {client.addisonNo ? ` · Addison ${client.addisonNo}` : ''}
          </p>
          {(() => {
            const berufstraeger = client.responsibilities.find((r) => r.role === 'BERUFSTRAEGER');
            const bearbeiter = client.responsibilities.filter((r) => r.role === 'HAUPTBEARBEITER');
            if (!berufstraeger && bearbeiter.length === 0) return null;
            return (
              <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                {berufstraeger && (
                  <p>
                    <span className="font-medium text-gray-700">Berufsträger:</span>{' '}
                    {berufstraeger.staff.fullName}
                  </p>
                )}
                {bearbeiter.length > 0 && (
                  <p>
                    <span className="font-medium text-gray-700">Bearbeiter:</span>{' '}
                    {bearbeiter.map((r) => r.staff.fullName).join(', ')}
                  </p>
                )}
              </div>
            );
          })()}
        </div>
        <Link
          href={`/staff/clients/${client.id}/edit`}
          className="btn-primary text-xs py-1.5 shrink-0"
        >
          Stammdaten bearbeiten
        </Link>
      </div>

      {(() => {
        const ob = computeOnboardingStatus({
          allowActive: client.allowActive,
          contactsActive: client.contacts.length,
          gwgChecks: client._count.gwgChecks,
          gwgInvites: client._count.gwgInvites,
          poas: client._count.poas,
          requests: client.requests.length,
        });
        if (ob === 'COMPLETE') return null;
        const next = resumeStep({
          allowActive: client.allowActive,
          contactsActive: client.contacts.length,
          gwgChecks: client._count.gwgChecks,
          gwgInvites: client._count.gwgInvites,
          poas: client._count.poas,
          requests: client.requests.length,
        });
        return (
          <div className="mb-4 -mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 text-sm">
            <span className="text-amber-900 dark:text-amber-100 inline-flex items-center gap-2">
              <Wand2 className="h-4 w-4" />
              Onboarding {ob === 'IN_PROGRESS' ? 'läuft noch' : 'noch nicht gestartet'}.
            </span>
            <Link
              href={`/staff/clients/onboarding/${client.id}?step=${next}`}
              className="btn-primary text-xs py-1 inline-flex items-center gap-1"
            >
              {ob === 'IN_PROGRESS' ? 'Fortsetzen' : 'Starten'} →
            </Link>
          </div>
        );
      })()}

      {/* Navigation als horizontale Pill-Leiste — spart vertikalen Platz */}
      <nav className="flex flex-wrap gap-2 mb-6 -mt-4">
        <Link href={`/staff/clients/${client.id}/timeline`} className="btn-secondary text-xs py-1">Aktivitätsstrom</Link>
        {modules.timeTracking && (
          <Link href={`/staff/clients/${client.id}/billing`} className="btn-secondary text-xs py-1">Stunden abrechnen</Link>
        )}
        {modules.bwa && (
          <Link href={`/staff/clients/${client.id}/bwa`} className="btn-secondary text-xs py-1">BWA & Auswertungen</Link>
        )}
        <Link href={`/staff/clients/${client.id}/gwg`} className="btn-secondary text-xs py-1">GwG-Prüfung</Link>
        {modules.taxNotices && (
          <>
            <Link href={`/staff/clients/${client.id}/tax-schedule`} className="btn-secondary text-xs py-1">Steuertermine</Link>
            <Link href={`/staff/clients/${client.id}/notices`} className="btn-secondary text-xs py-1">Bescheide</Link>
          </>
        )}
        {modules.workflows && (
          <Link href={`/staff/clients/${client.id}/workflows`} className="btn-secondary text-xs py-1">Workflows</Link>
        )}
        {modules.forms && (
          <Link href={`/staff/clients/${client.id}/forms`} className="btn-secondary text-xs py-1">Formulare</Link>
        )}
        <Link href={`/staff/clients/${client.id}/change-requests`} className="btn-secondary text-xs py-1">
          Stammdaten-Änderungen
          {pendingChangeRequests > 0 && (
            <span className="badge-yellow ml-2">{pendingChangeRequests}</span>
          )}
        </Link>
      </nav>

      {/* Mandanten-Grid — alle Karten in der Reihenfolge/Position aus tenant_setting.client_detail.layout */}
      {(() => {
        const blocks: Record<ClientBlockKey, React.ReactNode> = {
          upcoming: (() => {
            // Vereinigt Steuertermine (modul-gated) + Appointments
            // (modul-gated). Wenn beide Module aus sind → kein Block.
            const showTax = modules.taxNotices;
            const showAppts = modules.appointments;
            if (!showTax && !showAppts) return null;

            type Row =
              | { kind: 'tax'; id: string; date: Date; title: string; sub: string; overdue: boolean }
              | { kind: 'appt'; id: string; date: Date; endsAt: Date; title: string; sub: string; status: string };

            const rows: Row[] = [];
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
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                  <h2 className="text-sm font-medium text-gray-900 flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-gray-400" />
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
                  <div className="border-b border-gray-200 dark:border-gray-800 bg-amber-50/40 dark:bg-amber-900/10">
                    <p className="px-6 pt-3 text-[11px] uppercase tracking-wide font-medium text-amber-700 dark:text-amber-300">
                      Offene Anfragen vom Mandanten
                    </p>
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
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
                  <p className="px-6 py-8 text-sm text-gray-400 text-center">Keine anstehenden Termine.</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {rows.map((r) => {
                      const dateFmt = new Intl.DateTimeFormat('de-DE');
                      const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
                      const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
                      if (r.kind === 'tax') {
                        const daysLeft = Math.ceil((r.date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
                        return (
                          <li key={`tax-${r.id}`} className="px-6 py-3 flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-gray-900 truncate inline-flex items-center gap-2">
                                {r.title}
                                <span className="badge-gray text-[10px]">Steuertermin</span>
                              </p>
                              <p className="text-xs text-gray-500">{r.sub}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className={r.overdue ? 'text-sm text-red-700 font-medium' : 'text-sm text-gray-900'}>
                                {dateFmt.format(r.date)}
                              </p>
                              <p className="text-xs text-gray-500">
                                {r.overdue ? `${-daysLeft} Tage überfällig` : `noch ${daysLeft} Tage`}
                              </p>
                            </div>
                          </li>
                        );
                      }
                      return (
                        <li key={`appt-${r.id}`} className="px-6 py-3 flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 truncate inline-flex items-center gap-2">
                              {r.title}
                              {r.status === 'CONFIRMED' && <span className="badge-green text-[10px]">bestätigt</span>}
                            </p>
                            <p className="text-xs text-gray-500">{r.sub}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm text-gray-900">{dateTimeFmt.format(r.date)}</p>
                            <p className="text-xs text-gray-500">– {timeFmt.format(r.endsAt)}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })(),
          workflows: !modules.workflows ? null : (
            <div key="workflows" className="card overflow-hidden">
              <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Aktive Workflows</h2>
                <Link href={`/staff/clients/${client.id}/workflows`} className="text-xs text-brand-700 hover:underline">
                  Alle ansehen →
                </Link>
              </div>
              {workflowInstances.length === 0 ? (
                <p className="px-6 py-6 text-sm text-gray-400 text-center">
                  Keine laufenden Workflows.{' '}
                  <Link href={`/staff/clients/${client.id}/workflows`} className="text-brand-700 hover:underline">
                    Workflow starten →
                  </Link>
                </p>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {workflowInstances.map((inst) => {
                    const total = inst.items.length;
                    const done = inst.items.filter((it) => it.doneAt).length;
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    const overdue = inst.items.some(
                      (it) => !it.doneAt && it.dueDate && it.dueDate.getTime() < Date.now(),
                    );
                    return (
                      <li key={inst.id}>
                        <Link
                          href={`/staff/clients/${client.id}/workflows/${inst.id}`}
                          className="block px-6 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/40"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate inline-flex items-center gap-2">
                                {inst.name}
                                {overdue && <span className="badge-red text-[10px]">überfällig</span>}
                              </p>
                              <p className="text-[11px] text-gray-500">
                                gestartet am {dateFmt.format(inst.startedAt)}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <span className="text-[11px] text-gray-500">{done}/{total}</span>
                              <div className="mt-0.5 h-1 w-20 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
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
          ),
          reminders: !modules.reminders ? null : (
            <RemindersBlock
              key="reminders"
              clientId={client.id}
              currentStaffId={staffId}
              staffOptions={staffList}
              initial={reminders.map((r) => ({
                id: r.id,
                dueDate: r.dueDate.toISOString(),
                subject: r.subject,
                notes: r.notes,
                doneAt: r.doneAt ? r.doneAt.toISOString() : null,
                assigneeName: r.assigneeStaffId ? (staffNameById.get(r.assigneeStaffId) ?? null) : null,
              }))}
            />
          ),
          binders: !modules.binders ? null : (
            <BindersBlock
              key="binders"
              clientId={client.id}
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
          ),
          handovers: !modules.handovers ? null : (
            <HandoversBlock
              key="handovers"
              clientId={client.id}
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
              }))}
            />
          ),
          phone_notes: !modules.phoneNotes ? null : (
            <div key="phone_notes" className="card overflow-hidden">
              <QuickPhoneNote
                clientId={client.id}
                contacts={client.contacts.map((c) => ({ fullName: c.fullName, phone: c.phone }))}
                staff={staffList}
                currentStaffId={session.user.staffId}
              />
              <PhoneNotesList
                currentStaffId={staffId}
                staffOptions={staffList}
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
                }))}
              />
            </div>
          ),
          contacts: (
            <ClientContactsPanel
              key="contacts"
              clientId={client.id}
              contacts={client.contacts.map((c) => ({
                id: c.id,
                email: c.email,
                fullName: c.fullName,
                phone: c.phone,
                role: c.role,
                lastLoginAt: c.lastLoginAt,
              }))}
            />
          ),
          master_data: (
            <div key="master_data" className="card p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">Stammdaten</h2>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Typ</dt>
                  <dd className="text-gray-900 font-medium">{kindLabels[client.kind]}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">DATEV-Nr.</dt>
                  <dd className="text-gray-900 font-medium">{client.datevNo ?? '—'}</dd>
                </div>
                {client.addisonNo && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Addison-Nr.</dt>
                    <dd className="text-gray-900 font-medium">{client.addisonNo}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-gray-500">Angelegt</dt>
                  <dd className="text-gray-900 font-medium">
                    {new Intl.DateTimeFormat('de-DE').format(client.createdAt)}
                  </dd>
                </div>
              </dl>
            </div>
          ),
          custom_fields: customDefsForKind.length === 0 ? null : (
            <div key="custom_fields" className="card p-6">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">
                Custom-Felder
              </h2>
              <dl className="space-y-3 text-sm">
                {customDefsForKind.map((d) => (
                  <div key={d.id} className="flex justify-between gap-3">
                    <dt className="text-gray-500">{d.label}</dt>
                    <dd className="text-gray-900 font-medium text-right break-words">
                      {formatCustomValue(d.type, customValuesById.get(d.id))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ),
          gwg_status: (
            <div key="gwg_status" className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">GwG-Status</h2>
                <Link href={`/staff/clients/${client.id}/gwg`} className="text-xs text-brand-700 hover:underline">
                  Prüfung öffnen →
                </Link>
              </div>
              {(() => {
                const latest = client.gwgChecks[0];
                if (!latest) {
                  return (
                    <p className="text-sm text-gray-600">
                      Noch keine Prüfung. Erst nach Verifikation kann der Mandant aktiv werden.
                    </p>
                  );
                }
                const isExpiring = latest.validUntil && latest.validUntil.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000;
                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {latest.status === 'VERIFIED' && <span className="badge-green">Verifiziert</span>}
                      {latest.status === 'IN_REVIEW' && <span className="badge-yellow">In Prüfung</span>}
                      {latest.status === 'DRAFT' && <span className="badge-gray">Entwurf</span>}
                      {latest.status === 'REJECTED' && <span className="badge-red">Abgelehnt</span>}
                      {latest.status === 'EXPIRED' && <span className="badge-red">Abgelaufen</span>}
                      {latest.riskLevel === 'HIGH' && <span className="badge-red">Risiko: HIGH</span>}
                      {latest.riskLevel === 'MEDIUM' && <span className="badge-yellow">Risiko: MEDIUM</span>}
                      {latest.riskLevel === 'LOW' && <span className="badge-green">Risiko: LOW</span>}
                    </div>
                    {latest.validUntil && (
                      <p className={isExpiring ? 'text-xs text-yellow-700' : 'text-xs text-gray-500'}>
                        Gültig bis {new Intl.DateTimeFormat('de-DE').format(latest.validUntil)}
                        {isExpiring && ' · läuft bald aus'}
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          ),
          requests: (
            <div key="requests" className="card overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                <h2 className="text-sm font-medium text-gray-900">Anforderungen</h2>
                {client.allowActive && (
                  <Link href={`/staff/clients/${client.id}/requests/new`} className="btn-primary text-xs py-1.5">
                    <Plus className="h-3.5 w-3.5" />
                    Neue Anforderung
                  </Link>
                )}
              </div>
              {client.requests.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <Inbox className="h-10 w-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-400">Noch keine Anforderungen.</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Titel</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Priorität</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Fällig</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Letzte Antwort</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {client.requests.map((req) => {
                      const last = req.responses[0];
                      return (
                        <tr key={req.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 font-medium text-gray-900">
                            <Link href={`/staff/requests/${req.id}`} className="hover:underline">
                              {req.title}
                            </Link>
                          </td>
                          <td className="px-6 py-4">
                            {req.status === 'OPEN' && <span className="badge-yellow">{statusLabels[req.status]}</span>}
                            {req.status === 'IN_PROGRESS' && <span className="badge-yellow">{statusLabels[req.status]}</span>}
                            {req.status === 'RESPONDED' && <span className="badge-green">{statusLabels[req.status]}</span>}
                            {req.status === 'CLOSED' && <span className="badge-gray">{statusLabels[req.status]}</span>}
                            {req.status === 'CANCELLED' && <span className="badge-gray">{statusLabels[req.status]}</span>}
                          </td>
                          <td className="px-6 py-4 text-gray-600">
                            {req.priority === 'URGENT' && <span className="badge-red">{priorityLabels[req.priority]}</span>}
                            {req.priority === 'HIGH' && <span className="badge-yellow">{priorityLabels[req.priority]}</span>}
                            {req.priority === 'NORMAL' && priorityLabels[req.priority]}
                            {req.priority === 'LOW' && <span className="text-gray-400">{priorityLabels[req.priority]}</span>}
                          </td>
                          <td className="px-6 py-4 text-gray-600">
                            {req.dueAt ? new Intl.DateTimeFormat('de-DE').format(req.dueAt) : '—'}
                          </td>
                          <td className="px-6 py-4 text-gray-600">
                            {last ? new Intl.DateTimeFormat('de-DE').format(last.createdAt) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ),
          documents: (
            <div key="documents">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-medium text-gray-900">Dokumente</h2>
                {client.documents.some((d) =>
                  ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'].includes(d.classification),
                ) && (
                  <a
                    href={`/api/staff/clients/${client.id}/datev-belege-export`}
                    className="btn-secondary text-xs"
                    title="Alle GoBD-Belege als ZIP mit Begleitliste"
                  >
                    <Archive className="h-4 w-4" />
                    DATEV-Belege (ZIP)
                  </a>
                )}
              </div>
              {!client.allowActive && (
                <p className="text-xs text-yellow-600 mb-2">
                  Dokumente können erst nach GwG-Freischaltung hochgeladen werden.
                </p>
              )}
              <DocumentsManager
                clientId={client.id}
                canUpload={client.allowActive}
                scopeLabel={client.name}
                folders={client.documentFolders}
                documents={managerDocs.map((d) => {
                  const tier: 'NONE' | 'GWG' | 'GOBD' =
                    d.documentType?.tier ??
                    (['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'].includes(d.classification)
                      ? 'GOBD'
                      : d.classification === 'GWG_EVIDENCE'
                        ? 'GWG'
                        : 'NONE');
                  return {
                    id: d.id,
                    title: d.title,
                    classification: d.classification,
                    typeName: d.documentType?.name ?? '',
                    typeId: d.documentTypeId,
                    tier,
                    sizeBytes: d.versions[0] ? Number(d.versions[0].sizeBytes) : 0,
                    createdAt: d.createdAt.toISOString(),
                    folderId: d.folderId,
                    deletedAt: d.deletedAt ? d.deletedAt.toISOString() : null,
                    shared: d.sharedWithClientAt != null,
                  };
                })}
              />
            </div>
          ),
        };
        return (
          <div className="mb-8">
            <CockpitGrid items={clientLayout.items} blocks={blocks} />
          </div>
        );
      })()}

    </div>
  );
}
