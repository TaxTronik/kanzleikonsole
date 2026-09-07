// REMINDER-TICKET-001: Zustands- und Zugriffsfilter wirken vor der Seitennavigation.
import Link from 'next/link';
import { CalendarClock, Search } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin, accessibleClientsWhereFor } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import {
  loadReminderOverview,
  type ReminderScope,
  type ReminderStatus,
} from '@/server/reminders/queries';
import { OffsetPagination } from '@/components/offset-pagination';
import { RemindersOverview } from './reminders-overview';
import { NewReminderForm } from './new-reminder-form';
import { NotifyModeToggle } from './notify-mode-toggle';

type SearchParams = { scope?: string; status?: string; q?: string; page?: string };
const SCOPES: Array<{ key: ReminderScope; label: string }> = [
  { key: 'mir', label: 'An mich' },
  { key: 'vonmir', label: 'Von mir' },
  { key: 'alle', label: 'Alle zugänglichen' },
];
const STATUSES: Array<{ key: ReminderStatus; label: string }> = [
  { key: 'open', label: 'Offen' },
  { key: 'done', label: 'Erledigt' },
  { key: 'archived', label: 'Archiv' },
];

export default async function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const sp = await searchParams;
  const scope: ReminderScope = sp.scope === 'vonmir' || sp.scope === 'alle' ? sp.scope : 'mir';
  const status: ReminderStatus =
    sp.status === 'done' || sp.status === 'archived' ? sp.status : 'open';
  const q = (sp.q ?? '').trim().slice(0, 200);
  const requestedPage = Number(sp.page ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  const overview = await loadReminderOverview(ctx, session, {
    scope,
    status,
    q,
    page,
    pageSize: 25,
  });
  const { clients, staffOptions, notifyMode } = await withTenantContext(ctx, async (tx) => ({
    clients: await tx.client.findMany({
      where: await accessibleClientsWhereFor(tx, session),
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true },
    }),
    staffOptions: await tx.staffUser.findMany({
      where: { active: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    }),
    notifyMode:
      (
        await tx.staffUser.findUnique({
          where: { id: staffId },
          select: { reminderNotifyMode: true },
        })
      )?.reminderNotifyMode ?? ('ALL' as const),
  }));
  const baseQs = new URLSearchParams({ scope, status });
  if (q) baseQs.set('q', q);
  function tabLink(key: 'scope' | 'status', value: string) {
    const params = new URLSearchParams(baseQs);
    params.set(key, value);
    return `/staff/reminders?${params}`;
  }
  return (
    <div className="p-4 sm:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <CalendarClock className="h-6 w-6 text-disabled" />
          Wiedervorlagen
        </h1>
        <p className="text-muted text-sm mt-1">
          Aufgaben als Tickets — mit Fälligkeit, Zuständigen und gemeinsamer Unterhaltung.
        </p>
      </div>
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <NewReminderForm clients={clients} staffOptions={staffOptions} />
        <NotifyModeToggle initial={notifyMode} />
      </div>
      <nav aria-label="Ticketzuständigkeit" className="flex flex-wrap gap-2 mb-4">
        {SCOPES.map((tab) => (
          <Link
            key={tab.key}
            href={tabLink('scope', tab.key)}
            aria-current={scope === tab.key ? 'page' : undefined}
            className={scope === tab.key ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <nav aria-label="Ticketstatus" className="flex gap-2">
          {STATUSES.map((tab) => (
            <Link
              key={tab.key}
              href={tabLink('status', tab.key)}
              aria-current={status === tab.key ? 'page' : undefined}
              className={status === tab.key ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <form action="/staff/reminders" method="get" className="flex items-center gap-2">
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="status" value={status} />
          <input
            key={`${scope}:${status}:${q}`}
            type="search"
            name="q"
            aria-label="Tickets nach Nummer oder Titel suchen"
            placeholder="#123 oder Titel"
            defaultValue={q}
            maxLength={200}
            className="input text-sm"
          />
          <button type="submit" className="btn-secondary text-xs">
            <Search className="h-4 w-4" />
            Suchen
          </button>
          {q && (
            <Link
              href={tabLink('status', status).replace(/&q=[^&]*/, '')}
              className="text-xs text-muted hover:underline"
            >
              Zurücksetzen
            </Link>
          )}
        </form>
      </div>
      <div className="card overflow-hidden">
        <RemindersOverview
          key={`${scope}:${status}:${q}`}
          scope={scope}
          status={status}
          currentStaffId={staffId}
          canPrioritizeAll={isStaffAdmin(session)}
          rows={overview.rows}
        />
        <OffsetPagination
          basePath="/staff/reminders"
          baseQs={baseQs}
          page={overview.page}
          pageSize={overview.pageSize}
          totalCount={overview.total}
        />
      </div>
    </div>
  );
}
