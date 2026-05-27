/**
 * Render-Funktionen für die einzelnen Dashboard-Widgets.
 *
 * List-Widgets nutzen `h-full flex flex-col` (Header sticky oben, Body
 * flex-1 mit overflow-hidden) — beim Resize fließt naturgemäß mehr oder
 * weniger rein, ohne Scrollbar. Pre-Fetch von 20 Items deckt typische
 * Widget-Höhen ab.
 */

import Link from 'next/link';
import {
  Users,
  Inbox,
  FileText,
  Phone,
  IdCard,
  Workflow,
  Activity,
  CalendarDays,
  ShieldAlert,
  FileWarning,
  Newspaper,
  ExternalLink,
  BookmarkCheck,
  StickyNote,
  ListChecks,
  CalendarClock,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { actionLabel, resourceLabel } from '@/server/audit/labels';
import type { WidgetType } from '@/server/dashboard/widgets';
import { TaxNewsToggle } from './tax-news-toggle';
import { RssReaderManage } from './rss-reader-manage';
import { BookmarkButton } from './bookmark-button';
import { BookmarkRemoveButton } from './bookmark-remove-button';
import { NotesEditor } from './notes-editor';
import { MyDayToggle } from './my-day-toggle';
import { PhoneNoteRow } from './phone-note-check';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

const dateFmtShort = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short' });

const NOTICE_KIND_LABELS: Record<string, string> = {
  USTA: 'USt-Voranmeldung',
  UST_JAHR: 'USt-Jahresbescheid',
  EST: 'Einkommensteuer',
  KST: 'Körperschaftsteuer',
  GEWST_MESSBESCHEID: 'GewSt-Messbescheid',
  GEWST: 'GewSt-Bescheid',
  LSTA: 'LSt-Anmeldung',
  FESTSTELLUNG: 'Feststellungsbescheid',
  ZERLEGUNG: 'Zerlegungsbescheid',
  SONSTIGE: 'Sonstige',
};

interface RenderCtx {
  tx: Tx;
  staffId: string;
  isAdmin?: boolean;
}

export async function renderWidget(type: WidgetType, ctx: RenderCtx): Promise<React.ReactNode> {
  switch (type) {
    case 'kpi_clients':         return kpi(ctx, Users, 'Mandanten', '/staff/clients', (t) => t.client.count());
    case 'kpi_open_requests':   return kpi(ctx, Inbox, 'Offene Anforderungen', '/staff/requests?status=OPEN', (t) => t.request.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }), 'yellow');
    case 'kpi_documents':       return kpi(ctx, FileText, 'Dokumente', '/staff/documents', (t) => t.document.count({ where: { deletedAt: null } }));
    case 'kpi_unread_notes':    return kpi(ctx, Phone, 'Offene Telefonzettel', '/staff/phone-notes', (t) => t.phoneNote.count({ where: { doneAt: null } }), 'yellow');
    case 'kpi_pending_change_requests':
      return kpi(ctx, IdCard, 'Offene Stammdaten-Anträge', '/staff/dashboard', (t) => t.clientMasterChangeRequest.count({ where: { status: 'PENDING' } }), 'yellow');
    case 'kpi_open_workflows':
      return kpi(ctx, Workflow, 'Laufende Workflows', '/staff/workflows', (t) => t.workflowInstance.count({ where: { status: 'ACTIVE' } }));
    case 'recent_activity':     return RecentActivity(ctx);
    case 'upcoming_requests':   return UpcomingRequests(ctx);
    case 'gwg_expiring':        return GwgExpiring(ctx);
    case 'unreviewed_notices':  return UnreviewedNotices(ctx);
    case 'my_tax_deadlines':    return TaxDeadlines(ctx);
    case 'calendar':            return CalendarWidget(ctx);
    case 'tax_news':            return TaxNews(ctx);
    case 'phone_notes':         return PhoneNotesWidget(ctx);
    case 'bookmarks':           return Bookmarks(ctx);
    case 'personal_notes':      return PersonalNotes(ctx);
    case 'my_workflow_items':   return MyDay(ctx);
    case 'my_workflows':        return MyWorkflows(ctx);
    case 'my_reminders':        return MyReminders(ctx);
    default:
      return <div className="card p-4 text-xs text-gray-500">Unbekanntes Widget: {type}</div>;
  }
}

// ---------------------------------------------------------------------------
// Shared list-widget shell
// ---------------------------------------------------------------------------

function ListShell({
  icon: Icon,
  title,
  children,
  emptyText,
  isEmpty,
  footer,
}: {
  icon?: LucideIcon;
  title: string;
  children: React.ReactNode;
  emptyText: string;
  isEmpty: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card h-full flex flex-col">
      <div className="px-5 py-3 border-b border-gray-200 flex items-center gap-2 shrink-0">
        {Icon && <Icon className="h-4 w-4 text-gray-400" />}
        <h2 className="text-sm font-medium text-gray-900">{title}</h2>
      </div>
      {isEmpty ? (
        <p className="px-5 py-8 text-sm text-gray-400 text-center flex-1">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {children}
        </ul>
      )}
      {footer && <div className="px-5 py-2 border-t border-gray-200 text-xs text-gray-400 shrink-0">{footer}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

async function kpi(
  ctx: RenderCtx,
  Icon: LucideIcon,
  label: string,
  href: string,
  count: (t: Tx) => Promise<number>,
  accent: 'gray' | 'yellow' = 'gray',
): Promise<React.ReactNode> {
  let value = 0;
  try {
    value = await count(ctx.tx);
  } catch {
    value = 0;
  }
  return (
    <Link href={href} className="card h-full p-4 hover:bg-gray-50 transition-colors group flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <Icon className={accent === 'yellow' && value > 0 ? 'h-4 w-4 text-yellow-600' : 'h-4 w-4 text-gray-400'} />
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide truncate">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Recent Activity
// ---------------------------------------------------------------------------

async function RecentActivity({ tx }: RenderCtx): Promise<React.ReactNode> {
  const [items, total] = await Promise.all([
    tx.auditLog.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 25,
      select: {
        id: true, occurredAt: true, action: true,
        actorType: true, actorId: true, resourceType: true,
      },
    }),
    tx.auditLog.count(),
  ]);
  // Actor-Namen in einem Rutsch auflösen (Staff/Mandant). actorId ist
  // text/null — UUIDs werden zu Namen gemappt, alles andere bleibt leer.
  type AuditRow = { actorType: string; actorId: string | null };
  const staffIds = [
    ...new Set(
      (items as AuditRow[])
        .filter((i) => i.actorType === 'STAFF' && i.actorId)
        .map((i) => i.actorId as string),
    ),
  ];
  const contactIds = [
    ...new Set(
      (items as AuditRow[])
        .filter((i) => i.actorType === 'CLIENT_CONTACT' && i.actorId)
        .map((i) => i.actorId as string),
    ),
  ];
  const [staffRows, contactRows] = await Promise.all([
    staffIds.length ? tx.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
    contactIds.length ? tx.clientContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
  ]);
  const nameById = new Map<string, string>();
  for (const s of staffRows) nameById.set(s.id, s.fullName);
  for (const c of contactRows) nameById.set(c.id, c.fullName);
  const actorLabel = (a: { actorType: string; actorId: string | null }): string => {
    const role = a.actorType === 'STAFF' ? 'Mitarbeiter' : a.actorType === 'CLIENT_CONTACT' ? 'Mandant' : 'System';
    const name = a.actorId ? nameById.get(a.actorId) : undefined;
    return name ? `${role} · ${name}` : role;
  };
  return (
    <ListShell
      icon={Activity}
      title="Letzte Aktivitäten"
      isEmpty={items.length === 0}
      emptyText="Noch keine Aktivitäten."
      footer={`Audit-Kette: ${total} Einträge — alle hash-versiegelt`}
    >
      {items.map((a: { id: bigint; occurredAt: Date; action: string; actorType: string; actorId: string | null; resourceType: string }) => (
        <li key={String(a.id)} className="px-5 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">{actionLabel(a.action)}</p>
              <p className="text-xs text-gray-500 truncate">
                {actorLabel(a)}
                {' · '}
                {resourceLabel(a.resourceType)}
              </p>
            </div>
            <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">
              {new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(a.occurredAt)}
            </span>
          </div>
        </li>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// Upcoming Requests
// ---------------------------------------------------------------------------

async function UpcomingRequests({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.request.findMany({
    where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { not: null } },
    orderBy: { dueAt: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell title="Fällige Anforderungen" isEmpty={items.length === 0} emptyText="Keine fälligen Anforderungen.">
      {items.map((r: { id: string; title: string; dueAt: Date | null; client: { name: string } }) => (
        <li key={r.id} className="px-5 py-2.5">
          <Link href={`/staff/requests/${r.id}`} className="block hover:bg-gray-50 -mx-5 px-5">
            <p className="text-sm font-medium text-gray-900 truncate">{r.title}</p>
            <p className="text-xs text-gray-500 truncate">
              {r.client.name}
              {r.dueAt ? ` · ${new Intl.DateTimeFormat('de-DE').format(r.dueAt)}` : ''}
            </p>
          </Link>
        </li>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// GwG-Ablauf
// ---------------------------------------------------------------------------

async function GwgExpiring({ tx }: RenderCtx): Promise<React.ReactNode> {
  const cutoff = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const checks = await tx.gwgCheck.findMany({
    where: { status: 'VERIFIED', validUntil: { lte: cutoff } },
    orderBy: { validUntil: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={ShieldAlert}
      title="GwG läuft bald aus"
      isEmpty={checks.length === 0}
      emptyText="Alle GwG-Prüfungen aktuell."
    >
      {checks.map((c: { id: string; validUntil: Date | null; client: { id: string; name: string } }) => (
        <li key={c.id} className="px-5 py-2.5">
          <Link href={`/staff/clients/${c.client.id}/gwg`} className="block hover:bg-gray-50 -mx-5 px-5">
            <p className="text-sm font-medium text-gray-900 truncate">{c.client.name}</p>
            <p className="text-xs text-gray-500 truncate">
              {c.validUntil ? `Gültig bis ${new Intl.DateTimeFormat('de-DE').format(c.validUntil)}` : 'ohne Gültigkeitsdatum'}
            </p>
          </Link>
        </li>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// Ungeprüfte Bescheide
// ---------------------------------------------------------------------------

async function UnreviewedNotices({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.taxNotice.findMany({
    where: { status: 'NEU' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={FileWarning}
      title="Ungeprüfte Bescheide"
      isEmpty={items.length === 0}
      emptyText="Alle Bescheide geprüft."
    >
      {items.map((n: { id: string; kind: string; createdAt: Date; client: { id: string; name: string } }) => (
        <li key={n.id} className="px-5 py-2.5">
          <Link href={`/staff/clients/${n.client.id}/notices`} className="block hover:bg-gray-50 -mx-5 px-5">
            <p className="text-sm font-medium text-gray-900 truncate">{n.client.name}</p>
            <p className="text-xs text-gray-500 truncate">
              {NOTICE_KIND_LABELS[n.kind] ?? n.kind} · eingegangen {new Intl.DateTimeFormat('de-DE').format(n.createdAt)}
            </p>
          </Link>
        </li>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// Steuertermine
// ---------------------------------------------------------------------------

async function TaxDeadlines({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.taxDeadline.findMany({
    where: { status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] } },
    orderBy: { dueDate: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  return (
    <ListShell
      icon={CalendarDays}
      title="Nächste Steuertermine"
      isEmpty={items.length === 0}
      emptyText="Keine Termine."
    >
      {items.map((d: { id: string; kind: keyof typeof SCHEDULE_LABELS; dueDate: Date; status: string; client: { id: string; name: string } }) => (
        <li key={d.id} className="px-5 py-2.5">
          <Link href={`/staff/tax-deadlines`} className="block hover:bg-gray-50 -mx-5 px-5">
            <p className="text-sm font-medium text-gray-900 truncate">{d.client.name}</p>
            <p className="text-xs text-gray-500 truncate">{SCHEDULE_LABELS[d.kind] ?? d.kind}</p>
            <p className={d.status === 'OVERDUE' ? 'text-xs text-red-700' : 'text-xs text-gray-500'}>
              fällig {new Intl.DateTimeFormat('de-DE').format(d.dueDate)}
              {d.status === 'OVERDUE' && ' · überfällig'}
            </p>
          </Link>
        </li>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// Kalender-Widget — vereinte Liste der nächsten Steuertermine + Termine
// ---------------------------------------------------------------------------

async function CalendarWidget({ tx }: RenderCtx): Promise<React.ReactNode> {
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 30);
  const [appts, deadlines] = await Promise.all([
    tx.appointment.findMany({
      where: { status: { not: 'CANCELLED' }, endsAt: { gte: new Date() }, startsAt: { lte: horizon } },
      orderBy: { startsAt: 'asc' },
      take: 20,
      select: {
        id: true, title: true, startsAt: true, endsAt: true, location: true, status: true,
        owner: { select: { fullName: true } },
        client: { select: { id: true, name: true } },
      },
    }),
    tx.taxDeadline.findMany({
      where: {
        status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
        dueDate: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), lte: horizon },
      },
      orderBy: { dueDate: 'asc' },
      take: 20,
      include: { client: { select: { id: true, name: true } } },
    }),
  ]);

  type Row =
    | { kind: 'appt'; id: string; date: Date; endsAt: Date; title: string; clientName: string | null; clientId: string | null; owner: string; location: string | null; status: string }
    | { kind: 'tax'; id: string; date: Date; title: string; clientName: string; clientId: string; overdue: boolean };

  const rows: Row[] = [];
  for (const a of appts as Array<{ id: string; title: string; startsAt: Date; endsAt: Date; location: string | null; status: string; owner: { fullName: string }; client: { id: string; name: string } | null }>) {
    rows.push({
      kind: 'appt',
      id: a.id,
      date: a.startsAt,
      endsAt: a.endsAt,
      title: a.title,
      clientName: a.client?.name ?? null,
      clientId: a.client?.id ?? null,
      owner: a.owner.fullName,
      location: a.location,
      status: a.status,
    });
  }
  for (const d of deadlines as Array<{ id: string; kind: keyof typeof SCHEDULE_LABELS; dueDate: Date; status: string; period: string; client: { id: string; name: string } }>) {
    rows.push({
      kind: 'tax',
      id: d.id,
      date: d.dueDate,
      title: `${SCHEDULE_LABELS[d.kind] ?? d.kind} ${d.period}`,
      clientName: d.client.name,
      clientId: d.client.id,
      overdue: d.status === 'OVERDUE',
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  const limited = rows.slice(0, 25);

  const dateFmt = new Intl.DateTimeFormat('de-DE');
  const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

  return (
    <ListShell
      icon={CalendarDays}
      title="Kalender"
      isEmpty={limited.length === 0}
      emptyText="Keine anstehenden Termine in den nächsten 30 Tagen."
    >
      {limited.map((r) =>
        r.kind === 'appt' ? (
          <li key={`appt-${r.id}`} className="px-5 py-2.5">
            <Link
              href={r.clientId ? `/staff/clients/${r.clientId}` : '/staff/calendar'}
              className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-5 px-5 -my-1 py-1 rounded"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate inline-flex items-center gap-2">
                  {r.title}
                  {r.status === 'CONFIRMED' && <span className="badge-green text-[10px]">bestätigt</span>}
                </p>
                <span className="text-xs text-gray-500 shrink-0">{dateFmt.format(r.date)}</span>
              </div>
              <p className="text-xs text-gray-500 truncate">
                {timeFmt.format(r.date)} – {timeFmt.format(r.endsAt)}
                {r.clientName ? ` · ${r.clientName}` : ''}
                {' · '}{r.owner}
                {r.location ? ` · ${r.location}` : ''}
              </p>
            </Link>
          </li>
        ) : (
          <li key={`tax-${r.id}`} className="px-5 py-2.5">
            <Link
              href={`/staff/clients/${r.clientId}`}
              className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-5 px-5 -my-1 py-1 rounded"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate inline-flex items-center gap-2">
                  {r.title}
                  <span className="badge-gray text-[10px]">Steuertermin</span>
                </p>
                <span className={r.overdue ? 'text-xs text-red-700 font-medium shrink-0' : 'text-xs text-gray-500 shrink-0'}>
                  {dateFmt.format(r.date)}
                </span>
              </div>
              <p className="text-xs text-gray-500 truncate">{r.clientName}</p>
            </Link>
          </li>
        ),
      )}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// BMF / BFH RSS-Feed-Widget
// ---------------------------------------------------------------------------

async function TaxNews({ tx, staffId, isAdmin }: RenderCtx): Promise<React.ReactNode> {
  // Eigene abonnierte Feed-URLs auflösen und Items dazu laden.
  const [feeds, staff, bookmarks] = await Promise.all([
    tx.rssFeed.findMany({
      where: { staffId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, url: true, color: true, active: true },
    }),
    tx.staffUser.findUnique({
      where: { id: staffId },
      select: { taxNewsNotify: true },
    }),
    tx.staffBookmark.findMany({
      where: { staffId, resourceType: 'tax_news_item' },
      select: { resourceId: true },
    }),
  ]);

  const activeUrls = feeds
    .filter((f: { active: boolean }) => f.active)
    .map((f: { url: string }) => f.url);

  // Pro URL → Feed-Name/Farbe für Badge-Darstellung
  const feedByUrl = new Map<string, { name: string; color: string | null }>();
  for (const f of feeds as Array<{ url: string; name: string; color: string | null }>) {
    feedByUrl.set(f.url, { name: f.name, color: f.color });
  }

  const items = activeUrls.length === 0
    ? []
    : await tx.taxNewsItem.findMany({
        where: { source: { in: activeUrls } },
        orderBy: [{ publishedAt: 'desc' }, { fetchedAt: 'desc' }],
        take: 20,
      });
  const bookmarkedIds = new Set<string>(bookmarks.map((b: { resourceId: string }) => b.resourceId));

  function badgeClass(color: string | null): string {
    switch (color) {
      case 'blue':   return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200';
      case 'purple': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200';
      case 'green':  return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
      case 'amber':  return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
      case 'pink':   return 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200';
      case 'slate':  return 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200';
      default:       return 'bg-gray-100 text-gray-800 dark:bg-gray-800/60 dark:text-gray-200';
    }
  }

  return (
    <div className="card h-full flex flex-col">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-2 shrink-0 relative">
        <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-gray-400" />
          RSS-Reader
        </h2>
        <div className="flex items-center gap-1 relative">
          <RssReaderManage
            feeds={(feeds as Array<{ id: string; name: string; url: string; color: string | null; active: boolean }>).map((f) => ({
              id: f.id,
              name: f.name,
              url: f.url,
              color: f.color,
              active: f.active,
            }))}
          />
          <TaxNewsToggle
            enabled={Boolean(staff?.taxNewsNotify)}
            canTriggerFetch={Boolean(isAdmin)}
          />
        </div>
      </div>
      {activeUrls.length === 0 ? (
        <div className="px-5 py-8 text-sm text-gray-400 text-center flex-1">
          Keine aktiven Feeds. Über das Zahnrad oben einen Feed hinzufügen oder
          BMF/BFH-Defaults wiederherstellen.
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8 text-sm text-gray-400 text-center flex-1">
          Noch keine Einträge. Der Worker zieht die Feeds täglich morgens; Admins
          können über das Glocken-Icon manuell aktualisieren.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800 overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {items.map((n: {
            id: string;
            source: string;
            title: string;
            link: string;
            publishedAt: Date | null;
            fetchedAt: Date;
          }) => {
            const feedMeta = feedByUrl.get(n.source);
            const label = feedMeta?.name ?? '?';
            const color = feedMeta?.color ?? null;
            return (
              <li key={n.id} className="px-5 py-2.5 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <a
                    href={n.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -ml-5 pl-5 -mr-2 pr-2 py-1 rounded"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 flex-1">
                        {n.title}
                      </p>
                      <ExternalLink className="h-3 w-3 text-gray-300 shrink-0 mt-1" />
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      <span className={'inline-block rounded px-1.5 py-0.5 mr-1.5 text-[10px] font-medium ' + badgeClass(color)}>
                        {label}
                      </span>
                      {n.publishedAt
                        ? dateFmtShort.format(n.publishedAt)
                        : `Gefunden ${dateFmtShort.format(n.fetchedAt)}`}
                    </p>
                  </a>
                </div>
                <BookmarkButton
                  resourceType="tax_news_item"
                  resourceId={n.id}
                  label={`${label}: ${n.title}`}
                  href={n.link}
                  initiallyBookmarked={bookmarkedIds.has(n.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telefonzettel-Widget
// ---------------------------------------------------------------------------

async function PhoneNotesWidget({ tx }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.phoneNote.findMany({
    where: { doneAt: null },
    orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <ListShell
      icon={Phone}
      title="Telefonzettel"
      isEmpty={items.length === 0}
      emptyText="Keine Telefonzettel."
      footer={
        <Link
          href="/staff/phone-notes"
          className="inline-flex items-center gap-1 text-brand-700 hover:underline"
        >
          <Plus className="h-3.5 w-3.5" />
          Neuen Telefonzettel anlegen
        </Link>
      }
    >
      {items.map((p: {
        id: string;
        subject: string;
        body: string;
        callerName: string;
        callerPhone: string | null;
        readAt: Date | null;
        createdAt: Date;
        client: { id: string; name: string } | null;
      }) => (
        <PhoneNoteRow
          key={p.id}
          id={p.id}
          className={'px-5 py-2.5 ' + (p.readAt ? '' : 'bg-yellow-50/30 dark:bg-yellow-900/10')}
        >
          <Link href="/staff/phone-notes" className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -my-1 py-1 -mr-2 pr-2 rounded">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.subject}</p>
              {!p.readAt && <span className="badge-yellow text-[10px]">neu</span>}
            </div>
            <p className="text-xs text-gray-500 truncate">
              {p.callerName}
              {p.callerPhone ? ` · ${p.callerPhone}` : ''}
              {p.client ? ` · ${p.client.name}` : ''}
            </p>
            <p className="text-[10px] text-gray-400">{dateTimeFmt.format(p.createdAt)}</p>
          </Link>
        </PhoneNoteRow>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// Gemerkt-Widget (persönliche Bookmarks)
// ---------------------------------------------------------------------------

async function Bookmarks({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
  const items = await tx.staffBookmark.findMany({
    where: { staffId },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  return (
    <ListShell
      icon={BookmarkCheck}
      title="Gemerkt"
      isEmpty={items.length === 0}
      emptyText="Noch nichts gemerkt. In anderen Widgets das Lesezeichen-Icon klicken."
    >
      {items.map((b: {
        id: string;
        label: string;
        href: string | null;
        resourceType: string;
        createdAt: Date;
      }) => (
        <li key={b.id} className="px-5 py-2.5 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {b.href ? (
              <a
                href={b.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -ml-5 pl-5 -mr-2 pr-2 py-0.5 rounded"
              >
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
                  {b.label}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {resourceLabel(b.resourceType)} · gemerkt {dateFmtShort.format(b.createdAt)}
                </p>
              </a>
            ) : (
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">{b.label}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {resourceLabel(b.resourceType)} · gemerkt {dateFmtShort.format(b.createdAt)}
                </p>
              </div>
            )}
          </div>
          <BookmarkRemoveButton id={b.id} />
        </li>
      ))}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// Persönliche-Notizen-Widget
// ---------------------------------------------------------------------------

async function PersonalNotes({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
  const notes = await tx.staffNote.findMany({
    where: { staffId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return (
    <div className="card h-full flex flex-col">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <StickyNote className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Persönliche Notizen</h2>
      </div>
      <NotesEditor
        initial={notes.map((n: { id: string; body: string; updatedAt: Date }) => ({
          id: n.id,
          body: n.body,
          updatedAt: n.updatedAt,
        }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Mein Tag" — offene Workflow-Schritte, die mir zugewiesen sind
// ---------------------------------------------------------------------------

async function MyDay({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
  // Postgres sortiert NULL standardmäßig nach Werten bei ASC; wir wollen
  // fällige Items zuerst, undatierte am Ende. Daher dueDate asc + nulls last
  // über zweiten Pass nicht nötig: Prisma kann `sort: 'asc', nulls: 'last'`.
  const items = await tx.workflowItem.findMany({
    where: {
      assigneeStaffId: staffId,
      doneAt: null,
      instance: { status: 'ACTIVE' },
    },
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: 20,
    select: {
      id: true,
      title: true,
      dueDate: true,
      instance: { select: { id: true, clientId: true, name: true, client: { select: { name: true } } } },
    },
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <ListShell
      icon={ListChecks}
      title="Mein Tag"
      isEmpty={items.length === 0}
      emptyText="Keine offenen Workflow-Schritte für Sie."
    >
      {items.map((it: {
        id: string;
        title: string;
        dueDate: Date | null;
        instance: { id: string; clientId: string; name: string; client: { name: string } };
      }) => {
        const overdue = it.dueDate && it.dueDate.getTime() < today.getTime();
        return (
          <li key={it.id} className="px-5 py-2.5 flex items-start gap-3">
            <MyDayToggle id={it.id} />
            <Link
              href={`/staff/clients/${it.instance.clientId}/workflows`}
              className="flex-1 min-w-0 block hover:bg-gray-50 dark:hover:bg-gray-800/60 -my-1 py-1 -mr-2 pr-2 rounded"
            >
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{it.title}</p>
              <p className="text-xs text-gray-500 truncate">
                {it.instance.client.name} · {it.instance.name}
              </p>
              {it.dueDate && (
                <p className={overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-gray-500'}>
                  fällig {dateFmtShort.format(it.dueDate)}
                  {overdue && ' · überfällig'}
                </p>
              )}
            </Link>
          </li>
        );
      })}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// „Meine Workflows" — Workflow-Instanzen, in denen ich involviert bin
// ---------------------------------------------------------------------------

async function MyWorkflows({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
  const instances = await tx.workflowInstance.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { startedByStaff: staffId },
        { items: { some: { assigneeStaffId: staffId, doneAt: null } } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    take: 15,
    include: {
      client: { select: { id: true, name: true } },
      _count: { select: { items: true } },
      items: { where: { doneAt: { not: null } }, select: { id: true } },
    },
  });
  const dateFmtShort2 = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short' });

  return (
    <ListShell
      icon={Workflow}
      title="Meine Workflows"
      isEmpty={instances.length === 0}
      emptyText="Keine offenen Workflows."
      footer={instances.length > 0 ? (
        <Link href="/staff/workflows" className="text-brand-700 hover:underline">
          Alle Workflows ansehen →
        </Link>
      ) : undefined}
    >
      {instances.map((inst: {
        id: string;
        name: string;
        startedAt: Date;
        startedByStaff: string;
        client: { id: string; name: string };
        _count: { items: number };
        items: { id: string }[];
      }) => {
        const done = inst.items.length;
        const total = inst._count.items;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const startedByMe = inst.startedByStaff === staffId;
        return (
          <li key={inst.id} className="px-5 py-2.5">
            <Link
              href={`/staff/clients/${inst.client.id}/workflows`}
              className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-5 px-5"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {inst.name}
                </p>
                <span className="text-[10px] text-gray-400 shrink-0">
                  {done}/{total}
                </span>
              </div>
              <p className="text-xs text-gray-500 truncate">
                {inst.client.name}
                {startedByMe && <span className="ml-1 text-brand-700 dark:text-brand-300">· von mir</span>}
                <span className="ml-1">· {dateFmtShort2.format(inst.startedAt)}</span>
              </p>
              <div className="mt-1 h-1 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
              </div>
            </Link>
          </li>
        );
      })}
    </ListShell>
  );
}

// ---------------------------------------------------------------------------
// „Wiedervorlagen" — offene Reminders, mir zugewiesen oder von mir erstellt
// und niemandem zugewiesen. Fällig zuerst.
// ---------------------------------------------------------------------------

async function MyReminders({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
  const reminders = await tx.clientReminder.findMany({
    where: {
      doneAt: null,
      OR: [
        { assigneeStaffId: staffId },
        { assigneeStaffId: null, createdByStaff: staffId },
      ],
    },
    orderBy: { dueDate: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateFmtR = new Intl.DateTimeFormat('de-DE');

  return (
    <ListShell
      icon={CalendarClock}
      title="Wiedervorlagen"
      isEmpty={reminders.length === 0}
      emptyText="Keine offenen Wiedervorlagen."
    >
      {reminders.map((r: {
        id: string;
        dueDate: Date;
        subject: string;
        client: { id: string; name: string };
      }) => {
        const overdue = r.dueDate.getTime() < today.getTime();
        return (
          <li key={r.id} className="px-5 py-2.5">
            <Link
              href={`/staff/clients/${r.client.id}`}
              className="block hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-5 px-5"
            >
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{r.subject}</p>
              <p className="text-xs text-gray-500 truncate">{r.client.name}</p>
              <p className={overdue ? 'text-[11px] text-red-700 font-medium' : 'text-[11px] text-gray-500'}>
                fällig {dateFmtR.format(r.dueDate)}
                {overdue && ' · überfällig'}
              </p>
            </Link>
          </li>
        );
      })}
    </ListShell>
  );
}
