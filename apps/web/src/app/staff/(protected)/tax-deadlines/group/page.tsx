// =============================================================================
// /staff/tax-deadlines/group?kind=...&period=... — Mandanten-Liste pro Termin
//
// Zeigt für eine konkrete (kind, period)-Gruppe alle Mandanten und ob sie
// erledigt / in Bearbeitung / offen / überfällig sind. Quick-Action: einzelne
// Termine als erledigt markieren oder Auto-Anforderung öffnen.
// =============================================================================

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CalendarDays, CheckCheck, OctagonPause } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import type { Prisma, TaxScheduleKind } from '@prisma/client';
import { SCHEDULE_LABELS, berlinCalendarDate } from '@taxtronik/tax';
import {
  markDeadlineDoneAction,
  markDeadlinesDoneAction,
  suppressAutoRequestAction,
  suppressDeadlinesAction,
  unsuppressAutoRequestAction,
} from '../actions';
import { fmtDateShort } from '@/lib/fmt';
import { TAX_DEADLINE_STATUS_LABELS } from '@/lib/domain-labels';
import { deriveAutoRequestPipeline, type AutoRequestPipeline } from '@/lib/tax-deadline-pipeline';

const GROUP_STATUS_LABELS: Readonly<Record<string, string>> = {
  ...TAX_DEADLINE_STATUS_LABELS,
  REMINDED: 'Angefordert',
};

const GROUP_STATUS_BADGES: Readonly<Record<string, string>> = {
  OVERDUE: 'badge-red',
  REMINDED: 'badge-yellow',
  PLANNED: 'badge-gray',
  IN_PROGRESS: 'badge-yellow',
  SUBMITTED: 'badge-green',
  DONE: 'badge-green',
  SKIPPED: 'badge-gray',
};

type GroupDeadlineRow = {
  id: string;
  status: string;
  requestId: string | null;
  completedAt: Date | null;
  client: { id: string; name: string };
  pipeline: AutoRequestPipeline;
};

const VALID_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH',
  'USTA_QUARTAL',
  'USTA_JAEHRLICH',
  'LSTA_MONATLICH',
  'LSTA_QUARTAL',
  'LSTA_JAEHRLICH',
  'EST_VZ',
  'KST_VZ',
  'GEWST_VZ',
  'EST_ERKLAERUNG',
  'KST_ERKLAERUNG',
  'GEWST_ERKLAERUNG',
];

export default async function TaxDeadlineGroupPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; period?: string; scope?: string; q?: string }>;
}) {
  const session = await requireStaffPage();
  const sp = await searchParams;

  if (!sp.kind || !sp.period) notFound();
  if (!(VALID_KINDS as readonly string[]).includes(sp.kind)) notFound();
  const kind = sp.kind as TaxScheduleKind;
  const period = sp.period;
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const q = (sp.q ?? '').trim();

  const { tenantId, staffId } = session.user;

  // Client-Filter aufbauen: scope + Volltext-Suche kombinierbar.
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
  const where: Prisma.TaxDeadlineWhereInput = { kind, period };
  if (Object.keys(clientWhere).length > 0) {
    where.client = clientWhere;
  }

  const deadlines = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Termine gesperrter
      // Mandanten ausblenden.
      const denied = await inaccessibleClientIdsFor(tx, session);
      if (denied.length) where.clientId = { notIn: denied };
      return tx.taxDeadline.findMany({
        where,
        orderBy: [{ status: 'asc' }, { client: { name: 'asc' } }],
        include: {
          client: { select: { id: true, name: true } },
          config: {
            select: {
              active: true,
              autoRequest: true,
              reminderDaysBefore: true,
              staffLeadDays: true,
            },
          },
        },
      });
    },
  );

  // Abgeleiteter Auto-Anforderungs-Zustand pro Termin (kein eigener Status).
  const today = berlinCalendarDate(new Date());
  const rows = deadlines.map((d) => ({
    ...d,
    pipeline: deriveAutoRequestPipeline({
      status: d.status,
      requestId: d.requestId,
      staffNotifiedAt: d.staffNotifiedAt,
      autoRequestSuppressedAt: d.autoRequestSuppressedAt,
      autoRequestNotificationStatus: d.autoRequestNotificationStatus,
      autoRequestNotificationAttemptCount: d.autoRequestNotificationAttemptCount,
      autoRequestNotificationEscalatedAt: d.autoRequestNotificationEscalatedAt,
      dueDate: d.dueDate,
      config: d.config,
      today,
    }),
  }));

  // Aufteilen
  const groups: Record<string, typeof rows> = {
    OVERDUE: [],
    OPEN: [],
    DONE: [],
  };
  for (const d of rows) {
    if (d.status === 'OVERDUE') groups['OVERDUE']!.push(d);
    else if (d.status === 'DONE' || d.status === 'SKIPPED') groups['DONE']!.push(d);
    else groups['OPEN']!.push(d);
  }

  const dueDate = deadlines[0]?.dueDate;

  return (
    <div className="p-8 max-w-5xl">
      <Link href={`/staff/tax-deadlines?scope=${scope}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück zum Kalender
      </Link>

      <div className="mb-6">
        <div className="flex items-end justify-between mb-3">
          <div>
            <h1 className="page-title">
              <CalendarDays className="h-6 w-6 text-brand-600" />
              {SCHEDULE_LABELS[kind]}
            </h1>
            <p className="text-muted text-sm">
              Periode {period}
              {dueDate && ` · fällig am ${fmtDateShort(dueDate)}`}
              {' · '}
              {deadlines.length} Mandanten
              {q && (
                <span>
                  {' '}
                  · Suche: <strong className="text-primary">{q}</strong>
                </span>
              )}
            </p>
          </div>
        </div>
        <form method="get" action="/staff/tax-deadlines/group" className="flex items-center gap-2">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="period" value={period} />
          <input type="hidden" name="scope" value={scope} />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Mandant in dieser Gruppe filtern — Name, DATEV-Nr. oder Addison-Nr."
            className="input flex-1 text-sm"
            maxLength={120}
          />
          <button type="submit" className="btn-secondary text-xs">
            Filtern
          </button>
          {q && (
            <Link
              href={`/staff/tax-deadlines/group?kind=${kind}&period=${encodeURIComponent(period)}&scope=${scope}`}
              className="btn-secondary text-xs"
            >
              Zurücksetzen
            </Link>
          )}
        </form>
      </div>

      <form action={markDeadlinesDoneAction}>
        {groups['OVERDUE']!.length + groups['OPEN']!.length > 0 && (
          <div className="flex items-center justify-end gap-2 mb-3">
            <button
              type="submit"
              formAction={suppressDeadlinesAction}
              className="btn-secondary text-xs"
              title="Stoppt die automatische Anforderung der ausgewählten Termine (nur solange sie noch nicht versendet ist)."
            >
              <OctagonPause className="h-4 w-4" />
              Auto-Anforderung stoppen
            </button>
            <button type="submit" className="btn-secondary text-xs">
              <CheckCheck className="h-4 w-4" />
              Ausgewählte als erledigt markieren
            </button>
          </div>
        )}
        {groups['OVERDUE']!.length > 0 && (
          <Section title="Überfällig" rows={groups['OVERDUE']!} accent="red" selectable />
        )}
        <Section title="Offen / In Bearbeitung" rows={groups['OPEN']!} selectable />
      </form>
      {groups['DONE']!.length > 0 && (
        <Section title="Erledigt" rows={groups['DONE']!} accent="emerald" />
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  accent,
  selectable,
}: {
  title: string;
  rows: GroupDeadlineRow[];
  accent?: 'red' | 'emerald';
  selectable?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <section className="mb-6">
        <h2
          className={`text-sm font-semibold mb-3 ${accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-primary'}`}
        >
          {title} <span className="text-disabled font-normal">(0)</span>
        </h2>
        <div className="card p-6 text-center text-sm text-disabled">Keine Einträge.</div>
      </section>
    );
  }
  return (
    <section className="mb-6">
      <h2
        className={`text-sm font-semibold mb-3 ${accent === 'red' ? 'text-red-700' : accent === 'emerald' ? 'text-emerald-700' : 'text-primary'}`}
      >
        {title} <span className="text-disabled font-normal">({rows.length})</span>
      </h2>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <DeadlineTableRow key={row.id} row={row} selectable={selectable} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeadlineStatusBadge({ status }: { status: string }) {
  const className = GROUP_STATUS_BADGES[status];
  if (!className) return null;
  return <span className={className}>{GROUP_STATUS_LABELS[status]}</span>;
}

type RequestCreatedPipeline = Extract<AutoRequestPipeline, { state: 'REQUEST_CREATED' }>;

function requestNotificationLabel(pipeline: RequestCreatedPipeline): string {
  switch (pipeline.notificationState) {
    case 'PROVIDER_ACCEPTED':
      return 'Anforderung angelegt · Provider angenommen';
    case 'QUEUED':
      return 'Anforderung angelegt · Benachrichtigung vorgemerkt';
    case 'FAILED':
      return `Anforderung angelegt · Versandversuch ${pipeline.attemptCount} fehlgeschlagen`;
    case 'PARTIAL_FAILURE':
      return 'Anforderung angelegt · teilweise benachrichtigt, Prüfung offen';
    case 'NO_RECIPIENT':
      return 'Anforderung angelegt · kein Empfänger, Prüfung offen';
    case 'UNKNOWN':
      return 'Anforderung angelegt · Versandstatus unklar, Prüfung offen';
    case 'ESCALATED':
      return 'Anforderung angelegt · Versand intern eskaliert';
    default:
      return 'Anforderung angelegt · Benachrichtigung nicht nachgewiesen';
  }
}

function RequestCreatedStatus({ pipeline }: { pipeline: RequestCreatedPipeline }) {
  const providerAccepted = pipeline.notificationState === 'PROVIDER_ACCEPTED';
  const className = providerAccepted
    ? 'text-emerald-700 dark:text-emerald-300'
    : pipeline.notificationState === 'QUEUED'
      ? 'text-muted'
      : 'text-amber-700 dark:text-amber-300';
  const title = providerAccepted
    ? 'Der Versanddienst hat alle Einzelversuche technisch angenommen. Das ist kein Zugangs- oder Kenntnisnahmenachweis.'
    : 'Portal-Anforderung und externe Benachrichtigung werden getrennt geführt.';
  return (
    <span className={className} title={title}>
      {requestNotificationLabel(pipeline)}
    </span>
  );
}

function AutoRequestStatus({ pipeline }: { pipeline: AutoRequestPipeline }) {
  switch (pipeline.state) {
    case 'SCHEDULED':
      return <span className="text-muted">Versand am {fmtDateShort(pipeline.sendDate)}</span>;
    case 'WARNED':
      return (
        <span className="text-amber-700 dark:text-amber-300">
          Vorwarnung läuft — Versand am {fmtDateShort(pipeline.sendDate)}
        </span>
      );
    case 'SUPPRESSED':
      return (
        <span
          className="badge-gray"
          title="Auto-Anforderung gestoppt — Termin läuft normal weiter."
        >
          Gestoppt
        </span>
      );
    case 'REQUEST_CREATED':
      return <RequestCreatedStatus pipeline={pipeline} />;
    case 'ORPHANED':
      return (
        <span
          className="text-amber-700 dark:text-amber-300"
          title="Die Request-Verknüpfung wurde entfernt. Technische Versandmetadaten bleiben als Historie erhalten; es erfolgt kein automatischer Neuversand."
        >
          Request-Verknüpfung entfernt · Versandhistorie erhalten
        </span>
      );
    default:
      return null;
  }
}

function AutoRequestControl({ row, selectable }: { row: GroupDeadlineRow; selectable?: boolean }) {
  const controllable =
    selectable &&
    row.pipeline.state !== 'NONE' &&
    row.pipeline.state !== 'REQUEST_CREATED' &&
    row.pipeline.state !== 'ORPHANED';
  if (!controllable) return null;
  if (row.pipeline.state === 'SUPPRESSED') {
    return (
      <button
        type="submit"
        formAction={unsuppressAutoRequestAction}
        name="id"
        value={row.id}
        className="text-xs text-muted hover:text-brand-700"
        title="Stopp aufheben — der nächste Tageslauf versendet die Anforderung wieder wie konfiguriert."
      >
        Stopp aufheben
      </button>
    );
  }
  return (
    <button
      type="submit"
      formAction={suppressAutoRequestAction}
      name="id"
      value={row.id}
      className="text-xs text-muted hover:text-red-700"
      title="Auto-Anforderung stoppen — z. B. weil die Unterlagen bereits vorliegen."
    >
      Stoppen
    </button>
  );
}

function DeadlineActions({ row, selectable }: { row: GroupDeadlineRow; selectable?: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2">
      {row.requestId && (
        <Link
          href={`/staff/requests/${row.requestId}`}
          className="text-xs text-brand-700 hover:underline"
        >
          Anforderung
        </Link>
      )}
      {/* Zeilen liegen im äußeren Bulk-Formular — verschachtelte Formulare
          sind invalide, deshalb formAction + name/value am Button. */}
      <AutoRequestControl row={row} selectable={selectable} />
      {!selectable && row.status !== 'DONE' && row.status !== 'SKIPPED' && (
        <form action={markDeadlineDoneAction} className="inline">
          <input type="hidden" name="id" value={row.id} />
          <button type="submit" className="text-xs text-muted hover:text-emerald-700">
            ✓ Erledigt
          </button>
        </form>
      )}
    </div>
  );
}

function DeadlineTableRow({ row, selectable }: { row: GroupDeadlineRow; selectable?: boolean }) {
  return (
    <tr className="hover:bg-gray-50">
      {selectable && (
        <td className="pl-6 py-3 w-8">
          <input
            type="checkbox"
            name="ids"
            value={row.id}
            aria-label={`${row.client.name} auswählen`}
            className="h-4 w-4 rounded border-default text-brand-600 focus:ring-focus"
          />
        </td>
      )}
      <td className="px-6 py-3">
        <Link
          href={`/staff/clients/${row.client.id}`}
          className="text-primary font-medium hover:underline"
        >
          {row.client.name}
        </Link>
      </td>
      <td className="px-6 py-3">
        <DeadlineStatusBadge status={row.status} />
      </td>
      <td className="px-6 py-3 text-xs text-muted">
        {row.completedAt ? `am ${fmtDateShort(row.completedAt)}` : ''}
      </td>
      <td className="px-6 py-3 text-xs">
        {/* Auto-Anforderungs-Pipeline: abgeleitet, kein eigener Status. */}
        <AutoRequestStatus pipeline={row.pipeline} />
      </td>
      <td className="px-6 py-3 text-right">
        <DeadlineActions row={row} selectable={selectable} />
      </td>
    </tr>
  );
}
