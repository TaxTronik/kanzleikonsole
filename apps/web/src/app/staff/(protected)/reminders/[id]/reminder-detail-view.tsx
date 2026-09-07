'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Undo2, Copy, Users, Archive, ArchiveRestore, Link2 } from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { PRIORITY_BADGE, PRIORITY_LABEL } from '@/lib/reminder-priority';
import {
  markReminderDoneAction,
  reopenReminderAction,
  cloneReminderAction,
  archiveReminderAction,
  restoreReminderAction,
} from '../../clients/[id]/reminders/actions';
import type { ReminderDetail } from '@/server/reminders/detail';
import { TicketText } from '../ticket-text';
import { useMounted } from '../use-mounted';
import { TicketConversation } from './ticket-conversation';
import { TicketContext } from './ticket-context';
import { AssigneeForm, LinkedTicketForm, inZweiWochen } from './ticket-forms';
import { ticketHistoryHref } from './ticket-history-pagination';

/** REMINDER-TICKET-001: Beschreibung und Unterhaltung bleiben der Mittelpunkt. */
export function ReminderDetailView({
  detail,
  currentStaffId,
  canSteer,
  staffOptions,
}: {
  detail: ReminderDetail;
  currentStaffId: string;
  canSteer: boolean;
  staffOptions: Array<{ id: string; fullName: string }>;
}) {
  const router = useRouter();
  const mounted = useMounted();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'linked' | 'assignees' | null>(null);
  const archived = Boolean(detail.archivedAt);
  const done = Boolean(detail.doneAt);
  function run(
    action: () => Promise<{ ok: boolean; error?: string; id?: string }>,
    openNew = false,
  ) {
    setError(null);
    start(async () => {
      try {
        const result = await action();
        if (!mounted.current) return;
        if (!result.ok) {
          setError(result.error ?? 'Aktion fehlgeschlagen.');
          return;
        }
        if (openNew && result.id) router.push(`/staff/reminders/${result.id}`);
        else router.refresh();
      } catch {
        if (mounted.current) setError('Aktion fehlgeschlagen. Bitte erneut versuchen.');
      }
    });
  }
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="alert-error-sm">
          {error}
        </p>
      )}
      <TicketSummary detail={detail} />
      <div className="flex flex-wrap gap-2">
        {!archived &&
          (done ? (
            <button
              type="button"
              onClick={() => run(() => reopenReminderAction({ id: detail.id }))}
              disabled={pending}
              className="btn-secondary text-xs"
            >
              <Undo2 className="h-3.5 w-3.5" />
              Zurückholen
            </button>
          ) : (
            <button
              type="button"
              onClick={() => run(() => markReminderDoneAction({ id: detail.id }))}
              disabled={pending}
              className="btn-primary text-xs"
            >
              <Check className="h-3.5 w-3.5" />
              Erledigt
            </button>
          ))}
        {detail.canArchive && (
          <button
            type="button"
            onClick={() => run(() => archiveReminderAction({ id: detail.id }))}
            disabled={pending}
            className="btn-secondary text-xs"
          >
            <Archive className="h-3.5 w-3.5" />
            Archivieren
          </button>
        )}
        {detail.canRestore && (
          <button
            type="button"
            onClick={() => run(() => restoreReminderAction({ id: detail.id }))}
            disabled={pending}
            className="btn-secondary text-xs"
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
            Wiederherstellen
          </button>
        )}
        {!archived && canSteer && (
          <button
            type="button"
            onClick={() => setForm((current) => (current === 'assignees' ? null : 'assignees'))}
            disabled={pending}
            className="btn-secondary text-xs"
          >
            <Users className="h-3.5 w-3.5" />
            Zuständige ändern
          </button>
        )}
        {!archived && (
          <button
            type="button"
            onClick={() => setForm((current) => (current === 'linked' ? null : 'linked'))}
            disabled={pending}
            className="btn-secondary text-xs"
          >
            <Link2 className="h-3.5 w-3.5" />
            Neues verknüpftes Ticket
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            run(
              () =>
                cloneReminderAction({
                  id: detail.id,
                  alsNachfrage: false,
                  dueDate: inZweiWochen(),
                }),
              true,
            )
          }
          disabled={pending}
          className="btn-secondary text-xs"
        >
          <Copy className="h-3.5 w-3.5" />
          Klonen
        </button>
      </div>
      {archived && (
        <p className="text-xs text-muted">
          Archiviert am {fmtDateShort(new Date(detail.archivedAt!))}. Wiederherstellen legt das
          Ticket unter „Erledigt“ ab; erneutes Öffnen ist ein eigener Schritt.
        </p>
      )}
      {!archived && form === 'linked' && (
        <LinkedTicketForm
          reminderId={detail.id}
          staffOptions={staffOptions}
          assigneeIds={detail.assignees.map((staff) => staff.staffId)}
          onError={setError}
          onDone={(id) => {
            if (!mounted.current) return;
            setForm(null);
            if (id) router.push(`/staff/reminders/${id}`);
            else router.refresh();
          }}
        />
      )}
      {!archived && canSteer && form === 'assignees' && (
        <AssigneeForm
          reminderId={detail.id}
          staffOptions={staffOptions}
          assigneeIds={detail.assignees.map((staff) => staff.staffId)}
          onError={setError}
          onDone={() => {
            if (!mounted.current) return;
            setForm(null);
            router.refresh();
          }}
        />
      )}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] gap-4 items-start">
        <div className="min-w-0 space-y-4">
          <section aria-label="Beschreibung" className="card p-4 space-y-2">
            <h2 className="text-sm font-medium text-primary">Beschreibung</h2>
            {detail.description ? (
              <p className="text-sm text-secondary whitespace-pre-wrap break-words">
                <TicketText
                  text={detail.description}
                  references={detail.references}
                  staffOptions={staffOptions}
                />
              </p>
            ) : (
              <p className="text-xs text-muted">Keine Beschreibung hinterlegt.</p>
            )}
          </section>
          <TicketConversation key={detail.id} detail={detail} staffOptions={staffOptions} />
        </div>
        <TicketContext
          detail={detail}
          currentStaffId={currentStaffId}
          onUploaded={() => {
            if (!mounted.current) return;
            if (detail.attachmentsPage > 1)
              router.push(ticketHistoryHref(detail, { attachmentsPage: 1 }));
            else router.refresh();
          }}
        />
      </div>
    </div>
  );
}

function TicketSummary({ detail }: { detail: ReminderDetail }) {
  const archived = Boolean(detail.archivedAt);
  const done = Boolean(detail.doneAt);
  const badge = PRIORITY_BADGE[detail.priority];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={archived || done ? 'badge-gray' : 'badge-brand'}>
        {archived ? 'Archiviert' : done ? 'Erledigt' : 'Offen'}
      </span>
      {badge && <span className={`${badge} text-[11px]`}>{PRIORITY_LABEL[detail.priority]}</span>}
      <span className="text-xs text-muted">
        fällig {fmtDateShort(new Date(detail.dueDate))} · angelegt von{' '}
        {detail.createdByName ?? 'unbekannt'}
      </span>
      {done && (
        <span className="text-xs text-muted">
          · erledigt {fmtDateShort(new Date(detail.doneAt!))}
          {detail.doneByName ? ` von ${detail.doneByName}` : ''}
        </span>
      )}
    </div>
  );
}
