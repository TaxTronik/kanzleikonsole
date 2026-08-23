import type { ReactNode } from 'react';
// =============================================================================
// Personal-Widgets — pro-Mitarbeiter, persönlich gebunden.
//
// Bookmarks (gemerkte Items), PersonalNotes (Memo-Pad),
// MyDay (persönliche Aufgaben und Termine), MyWorkflows (laufende Instanzen
// die ich verfolge), MyReminders (offene Wiedervorlagen).
// =============================================================================

import Link from 'next/link';
import {
  Bell,
  BookmarkCheck,
  CalendarClock,
  CalendarDays,
  ListChecks,
  Phone,
  StickyNote,
  Workflow,
} from 'lucide-react';
import { berlinTodayUtcMidnight, fmtDateShort, fmtDateTimeShort, fmtTimeShort } from '@/lib/fmt';
import { NOTIFICATION_KIND_LABELS } from '@/lib/domain-labels';
import { resourceLabel } from '@/server/audit/labels';
import { loadMyDayEntries, type MyDayEntry } from '@/server/dashboard/my-day';
import { NotificationOpenLink } from '@/components/notification-open-link';
import { BookmarkRemoveButton } from '../bookmark-remove-button';
import { MyDayToggle } from '../my-day-toggle';
import { NotesEditor } from '../notes-editor';
import { ListShell, notDeniedClient, type RenderCtx } from './_shared';

// --- Bookmarks ---------------------------------------------------------------

export async function Bookmarks({ tx, staffId }: RenderCtx): Promise<ReactNode> {
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
      {items.map(
        (b: {
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
                  className="block hover:bg-gray-50 -ml-5 pl-5 -mr-2 pr-2 py-0.5 rounded"
                >
                  <p className="text-sm font-medium text-primary line-clamp-2">{b.label}</p>
                  <p className="text-[10px] text-disabled mt-0.5">
                    {resourceLabel(b.resourceType)} · gemerkt {fmtDateShort(b.createdAt)}
                  </p>
                </a>
              ) : (
                <div>
                  <p className="text-sm font-medium text-primary line-clamp-2">{b.label}</p>
                  <p className="text-[10px] text-disabled mt-0.5">
                    {resourceLabel(b.resourceType)} · gemerkt {fmtDateShort(b.createdAt)}
                  </p>
                </div>
              )}
            </div>
            <BookmarkRemoveButton id={b.id} />
          </li>
        ),
      )}
    </ListShell>
  );
}

// --- LatestNotifications ------------------------------------------------------

export async function LatestNotifications({ tx, staffId }: RenderCtx): Promise<ReactNode> {
  const items = await tx.notification.findMany({
    where: { OR: [{ staffId }, { staffId: null }] },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      kind: true,
      title: true,
      href: true,
      readAt: true,
      createdAt: true,
    },
  });
  return (
    <ListShell
      icon={Bell}
      title="Neueste Benachrichtigungen"
      isEmpty={items.length === 0}
      emptyText="Keine Benachrichtigungen."
      footer={
        <Link href="/staff/notifications" className="text-brand-700 hover:underline">
          Alle Benachrichtigungen →
        </Link>
      }
    >
      {items.map((n) => (
        <li key={n.id} className="px-5 py-2.5 flex items-start gap-2">
          <div
            className={
              n.readAt
                ? 'h-2 w-2 rounded-full bg-gray-200 mt-1.5 shrink-0'
                : 'h-2 w-2 rounded-full bg-brand-500 mt-1.5 shrink-0'
            }
          />
          <div className="flex-1 min-w-0">
            {n.href ? (
              <NotificationOpenLink
                id={n.id}
                href={n.href}
                unread={!n.readAt}
                className="block hover:bg-gray-50 -ml-5 pl-5 -mr-2 pr-2 py-0.5 rounded"
              >
                <p
                  className={
                    n.readAt
                      ? 'text-sm text-secondary line-clamp-2'
                      : 'text-sm font-medium text-primary line-clamp-2'
                  }
                >
                  {n.title}
                </p>
                <p className="text-[10px] text-disabled mt-0.5">
                  {NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind} · {fmtDateTimeShort(n.createdAt)}
                </p>
              </NotificationOpenLink>
            ) : (
              <div>
                <p
                  className={
                    n.readAt
                      ? 'text-sm text-secondary line-clamp-2'
                      : 'text-sm font-medium text-primary line-clamp-2'
                  }
                >
                  {n.title}
                </p>
                <p className="text-[10px] text-disabled mt-0.5">
                  {NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind} · {fmtDateTimeShort(n.createdAt)}
                </p>
              </div>
            )}
          </div>
        </li>
      ))}
    </ListShell>
  );
}

// --- PersonalNotes -----------------------------------------------------------

export async function PersonalNotes({ tx, staffId }: RenderCtx): Promise<ReactNode> {
  const notes = await tx.staffNote.findMany({
    where: { staffId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return (
    <div className="card h-full flex flex-col">
      <div className="px-5 py-3 border-b border-default flex items-center gap-2 shrink-0">
        <StickyNote className="h-4 w-4 text-disabled" />
        <h2 className="text-sm font-medium text-primary">Persönliche Notizen</h2>
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

// --- MyDay (persönliche Aufgaben und Termine) --------------------------------

export async function MyDay({
  tx,
  staffId,
  deniedClientIds,
  modules,
}: RenderCtx): Promise<ReactNode> {
  const items = await loadMyDayEntries(tx, staffId, deniedClientIds, new Date(), {
    workflows: modules.workflows,
    reminders: modules.reminders,
    appointments: modules.appointments,
    phoneNotes: modules.phoneNotes,
  });
  const today = berlinTodayUtcMidnight();

  function leading(entry: MyDayEntry): ReactNode {
    if (entry.kind === 'workflow') return <MyDayToggle id={entry.id} />;
    const Icon =
      entry.kind === 'reminder'
        ? CalendarClock
        : entry.kind === 'appointment'
          ? CalendarDays
          : Phone;
    return (
      <span className="mt-0.5 w-5 h-5 rounded border border-default flex items-center justify-center shrink-0">
        <Icon className="h-3 w-3 text-muted" />
      </span>
    );
  }

  function timing(entry: MyDayEntry): ReactNode {
    if (entry.kind === 'appointment') {
      return (
        <p className="text-xs text-muted">
          {fmtDateShort(entry.startsAt)} · {fmtTimeShort(entry.startsAt)}–
          {fmtTimeShort(entry.endsAt)}
        </p>
      );
    }
    if (entry.kind === 'phone-note') {
      return <p className="text-xs text-muted">eingegangen {fmtDateTimeShort(entry.receivedAt)}</p>;
    }
    if (!entry.dueAt) return <p className="text-xs text-muted">ohne Fälligkeit</p>;
    const overdue = entry.dueAt.getTime() < today.getTime();
    return (
      <p className={overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-muted'}>
        fällig {fmtDateShort(entry.dueAt)}
        {overdue && ' · überfällig'}
      </p>
    );
  }

  function kindLabel(kind: MyDayEntry['kind']): string {
    switch (kind) {
      case 'workflow':
        return 'Workflow';
      case 'reminder':
        return 'Wiedervorlage';
      case 'appointment':
        return 'Termin';
      case 'phone-note':
        return 'Telefonzettel';
    }
  }

  return (
    <ListShell
      icon={ListChecks}
      title="Mein Tag"
      isEmpty={items.length === 0}
      emptyText="Keine offenen Aufgaben oder anstehenden Termine für Sie."
    >
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="px-5 py-2.5 flex items-start gap-3">
          {leading(item)}
          <Link
            href={item.href}
            className="flex-1 min-w-0 block hover:bg-gray-50 -my-1 py-1 -mr-2 pr-2 rounded"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="item-title">{item.title}</p>
              <span className="text-[10px] text-disabled shrink-0">{kindLabel(item.kind)}</span>
            </div>
            {item.context && <p className="text-xs text-muted truncate">{item.context}</p>}
            {timing(item)}
          </Link>
        </li>
      ))}
    </ListShell>
  );
}

// --- MyWorkflows -------------------------------------------------------------

export async function MyWorkflows({ tx, staffId, deniedClientIds }: RenderCtx): Promise<ReactNode> {
  const instances = await tx.workflowInstance.findMany({
    where: {
      status: 'ACTIVE',
      ...notDeniedClient(deniedClientIds),
      OR: [
        { startedByStaff: staffId },
        { items: { some: { assigneeStaffId: staffId, doneAt: null } } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    take: 15,
    include: {
      client: { select: { id: true, name: true } },
      _count: {
        select: { items: { where: { doneAt: { not: null } } } },
      },
    },
  });

  const itemTotals = instances.length
    ? await tx.workflowItem.groupBy({
        by: ['instanceId'],
        where: { instanceId: { in: instances.map((instance) => instance.id) } },
        _count: { _all: true },
      })
    : [];
  const totalByInstanceId = new Map(itemTotals.map((row) => [row.instanceId, row._count._all]));

  return (
    <ListShell
      icon={Workflow}
      title="Meine Workflows"
      isEmpty={instances.length === 0}
      emptyText="Keine offenen Workflows."
      footer={
        instances.length > 0 ? (
          <Link href="/staff/workflows" className="text-brand-700 hover:underline">
            Alle Workflows ansehen →
          </Link>
        ) : undefined
      }
    >
      {instances.map(
        (inst: {
          id: string;
          name: string;
          startedAt: Date;
          startedByStaff: string;
          client: { id: string; name: string };
          _count: { items: number };
        }) => {
          const done = inst._count.items;
          const total = totalByInstanceId.get(inst.id) ?? 0;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const startedByMe = inst.startedByStaff === staffId;
          return (
            <li key={inst.id} className="px-5 py-2.5">
              <Link
                href={`/staff/clients/${inst.client.id}/workflows`}
                className="block hover:bg-gray-50 -mx-5 px-5"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="item-title">{inst.name}</p>
                  <span className="text-[10px] text-disabled shrink-0">
                    {done}/{total}
                  </span>
                </div>
                <p className="text-xs text-muted truncate">
                  {inst.client.name}
                  {startedByMe && (
                    <span className="ml-1 text-brand-700 dark:text-brand-300">· von mir</span>
                  )}
                  <span className="ml-1">· {fmtDateShort(inst.startedAt)}</span>
                </p>
                <div className="mt-1 h-1 rounded-full bg-gray-100 overflow-hidden">
                  <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
                </div>
              </Link>
            </li>
          );
        },
      )}
    </ListShell>
  );
}

// --- MyReminders (Wiedervorlagen) --------------------------------------------

export async function MyReminders({ tx, staffId, deniedClientIds }: RenderCtx): Promise<ReactNode> {
  const reminders = await tx.clientReminder.findMany({
    where: {
      doneAt: null,
      ...notDeniedClient(deniedClientIds),
      OR: [
        { assignees: { some: { staffId } } },
        { assignees: { none: {} }, createdByStaff: staffId },
      ],
    },
    orderBy: { dueDate: 'asc' },
    take: 20,
    include: { client: { select: { id: true, name: true } } },
  });
  const today = berlinTodayUtcMidnight();

  return (
    <ListShell
      icon={CalendarClock}
      title="Wiedervorlagen"
      isEmpty={reminders.length === 0}
      emptyText="Keine offenen Wiedervorlagen."
    >
      {reminders.map(
        (r: {
          id: string;
          dueDate: Date;
          subject: string;
          // null = interne Aufgabe ohne Mandantenbezug.
          client: { id: string; name: string } | null;
        }) => {
          const overdue = r.dueDate.getTime() < today.getTime();
          return (
            <li key={r.id} className="px-5 py-2.5">
              <Link
                href={r.client ? `/staff/clients/${r.client.id}` : '/staff/reminders'}
                className="block hover:bg-gray-50 -mx-5 px-5"
              >
                <p className="item-title">{r.subject}</p>
                <p className="text-xs text-muted truncate">
                  {r.client?.name ?? 'Intern (ohne Mandant)'}
                </p>
                <p
                  className={
                    overdue ? 'text-[11px] text-red-700 font-medium' : 'text-[11px] text-muted'
                  }
                >
                  fällig {fmtDateShort(r.dueDate)}
                  {overdue && ' · überfällig'}
                </p>
              </Link>
            </li>
          );
        },
      )}
    </ListShell>
  );
}
