// =============================================================================
// Personal-Widgets — pro-Mitarbeiter, persönlich gebunden.
//
// Bookmarks (gemerkte Items), PersonalNotes (Memo-Pad),
// MyDay (offene Workflow-Schritte mir zugewiesen), MyWorkflows (laufende
// Instanzen die ich verfolge), MyReminders (offene Wiedervorlagen).
// =============================================================================

import Link from 'next/link';
import {
  BookmarkCheck,
  CalendarClock,
  ListChecks,
  StickyNote,
  Workflow,
} from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { resourceLabel } from '@/server/audit/labels';
import { BookmarkRemoveButton } from '../bookmark-remove-button';
import { MyDayToggle } from '../my-day-toggle';
import { NotesEditor } from '../notes-editor';
import { ListShell, type RenderCtx } from './_shared';

// --- Bookmarks ---------------------------------------------------------------

export async function Bookmarks({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
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
      {items.map((b: { id: string; label: string; href: string | null; resourceType: string; createdAt: Date }) => (
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
      ))}
    </ListShell>
  );
}

// --- PersonalNotes -----------------------------------------------------------

export async function PersonalNotes({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
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

// --- MyDay (offene Workflow-Schritte) ----------------------------------------

export async function MyDay({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
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
              className="flex-1 min-w-0 block hover:bg-gray-50 -my-1 py-1 -mr-2 pr-2 rounded"
            >
              <p className="item-title">{it.title}</p>
              <p className="text-xs text-muted truncate">
                {it.instance.client.name} · {it.instance.name}
              </p>
              {it.dueDate && (
                <p className={overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-muted'}>
                  fällig {fmtDateShort(it.dueDate)}
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

// --- MyWorkflows -------------------------------------------------------------

export async function MyWorkflows({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
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
            <Link href={`/staff/clients/${inst.client.id}/workflows`} className="block hover:bg-gray-50 -mx-5 px-5">
              <div className="flex items-center justify-between gap-2">
                <p className="item-title">{inst.name}</p>
                <span className="text-[10px] text-disabled shrink-0">
                  {done}/{total}
                </span>
              </div>
              <p className="text-xs text-muted truncate">
                {inst.client.name}
                {startedByMe && <span className="ml-1 text-brand-700 dark:text-brand-300">· von mir</span>}
                <span className="ml-1">· {fmtDateShort(inst.startedAt)}</span>
              </p>
              <div className="mt-1 h-1 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
              </div>
            </Link>
          </li>
        );
      })}
    </ListShell>
  );
}

// --- MyReminders (Wiedervorlagen) --------------------------------------------

export async function MyReminders({ tx, staffId }: RenderCtx): Promise<React.ReactNode> {
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

  return (
    <ListShell
      icon={CalendarClock}
      title="Wiedervorlagen"
      isEmpty={reminders.length === 0}
      emptyText="Keine offenen Wiedervorlagen."
    >
      {reminders.map((r: { id: string; dueDate: Date; subject: string; client: { id: string; name: string } }) => {
        const overdue = r.dueDate.getTime() < today.getTime();
        return (
          <li key={r.id} className="px-5 py-2.5">
            <Link href={`/staff/clients/${r.client.id}`} className="block hover:bg-gray-50 -mx-5 px-5">
              <p className="item-title">{r.subject}</p>
              <p className="text-xs text-muted truncate">{r.client.name}</p>
              <p className={overdue ? 'text-[11px] text-red-700 font-medium' : 'text-[11px] text-muted'}>
                fällig {fmtDateShort(r.dueDate)}
                {overdue && ' · überfällig'}
              </p>
            </Link>
          </li>
        );
      })}
    </ListShell>
  );
}
