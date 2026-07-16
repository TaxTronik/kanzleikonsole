import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  FileText,
  Inbox,
  CheckCircle2,
  MessageSquare,
  Phone,
  Receipt,
  Send,
  CreditCard,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ScrollText,
  PenLine,
  Ban,
  FileWarning,
  CalendarCheck,
  ListChecks,
  Fingerprint,
  Lock,
} from 'lucide-react';
import { buildClientTimeline, type TimelineEvent } from '@/server/timeline/build';
import { fmtDateTimeMedium, fmtDateWeekdayLong } from '@/lib/fmt';

const ICON_MAP: Record<TimelineEvent['kind'], { icon: typeof FileText; tone: string }> = {
  document_uploaded: { icon: FileText, tone: 'text-blue-600 bg-blue-50' },
  request_opened: { icon: Inbox, tone: 'text-yellow-700 bg-yellow-50' },
  request_closed: { icon: CheckCircle2, tone: 'text-secondary bg-gray-100' },
  request_response_staff: { icon: MessageSquare, tone: 'text-brand-700 bg-brand-50' },
  request_response_client: { icon: MessageSquare, tone: 'text-emerald-700 bg-emerald-50' },
  phone_note: { icon: Phone, tone: 'text-purple-700 bg-purple-50' },
  invoice_created: { icon: Receipt, tone: 'text-secondary bg-gray-100' },
  invoice_sent: { icon: Send, tone: 'text-blue-700 bg-blue-50' },
  invoice_paid: { icon: CreditCard, tone: 'text-emerald-700 bg-emerald-50' },
  gwg_created: { icon: Shield, tone: 'text-yellow-700 bg-yellow-50' },
  gwg_verified: { icon: ShieldCheck, tone: 'text-emerald-700 bg-emerald-50' },
  gwg_rejected: { icon: ShieldAlert, tone: 'text-red-700 bg-red-50' },
  poa_created: { icon: ScrollText, tone: 'text-secondary bg-gray-100' },
  poa_signed: { icon: PenLine, tone: 'text-emerald-700 bg-emerald-50' },
  poa_revoked: { icon: Ban, tone: 'text-red-700 bg-red-50' },
  tax_notice_received: { icon: FileWarning, tone: 'text-amber-700 bg-amber-50' },
  tax_deadline_completed: { icon: CalendarCheck, tone: 'text-emerald-700 bg-emerald-50' },
  workflow_item_done: { icon: ListChecks, tone: 'text-emerald-700 bg-emerald-50' },
  risk_analysis_created: { icon: Fingerprint, tone: 'text-indigo-700 bg-indigo-50' },
  risk_analysis_archived: { icon: Lock, tone: 'text-secondary bg-gray-100' },
};

function formatRelative(d: Date, now: Date): string {
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
  return fmtDateTimeMedium(d);
}

function groupByDay(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const groups = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const key = e.occurredAt.toISOString().slice(0, 10);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  return groups;
}

/** Ein einzelnes Timeline-Ereignis (Icon-Punkt + Karte). Aus der Seite
 *  herausgezogen — flacht die tiefe Map-Verschachtelung deutlich ab. */
function TimelineEntry({ event, now }: { event: TimelineEvent; now: Date }) {
  const { icon: Icon, tone } = ICON_MAP[event.kind];
  return (
    <li className="ml-6">
      <span
        className={`absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white ${tone}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="card px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {event.href ? (
              <Link href={event.href} className="text-sm font-medium text-primary hover:underline">
                {event.title}
              </Link>
            ) : (
              <p className="text-sm font-medium text-primary">{event.title}</p>
            )}
            {event.detail && (
              <p className="text-xs text-muted mt-0.5 break-words">{event.detail}</p>
            )}
          </div>
          <time
            dateTime={event.occurredAt.toISOString()}
            title={fmtDateTimeMedium(event.occurredAt)}
            className="text-xs text-disabled whitespace-nowrap"
          >
            {formatRelative(event.occurredAt, now)}
          </time>
        </div>
      </div>
    </li>
  );
}

/** Ein Tages-Block (Datums-Überschrift + Ereignisliste). */
function TimelineDay({ day, events, now }: { day: string; events: TimelineEvent[]; now: Date }) {
  return (
    <section>
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
        {fmtDateWeekdayLong(new Date(day + 'T12:00:00.000Z'))}
      </h2>
      <ol className="relative border-l border-default ml-4 space-y-4">
        {events.map((e) => (
          <TimelineEntry key={e.id} event={e} now={now} />
        ))}
      </ol>
    </section>
  );
}

export default async function ClientTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ limit?: string }>;
}) {
  const session = await requireStaffPage();

  const { id } = await params;
  const sp = await searchParams;
  const limit = Math.min(Math.max(Number(sp.limit ?? '100'), 20), 500);
  const { tenantId, staffId } = session.user;

  const client = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.client.findUnique({
      where: { id },
      select: { id: true, name: true, datevNo: true },
    }),
  );
  if (!client) notFound();

  const events = await buildClientTimeline(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    { clientId: id, limit },
  );

  const grouped = groupByDay(events);
  const now = new Date();

  return (
    <div className="p-8 max-w-4xl">
      <Link href={`/staff/clients/${id}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück zum Mandanten
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Aktivitätsstrom</h1>
        <p className="text-muted text-sm">
          {client.name}
          {client.datevNo && <span className="ml-2 text-disabled">DATEV-Nr. {client.datevNo}</span>}
        </p>
      </div>

      {events.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-disabled">Noch keine Ereignisse erfasst.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Array.from(grouped.entries()).map(([day, list]) => (
            <TimelineDay key={day} day={day} events={list} now={now} />
          ))}

          {events.length === limit && (
            <div className="text-center">
              <Link
                href={`/staff/clients/${id}/timeline?limit=${limit + 100}`}
                className="btn-secondary text-xs"
              >
                Mehr Ereignisse laden
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
