'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Check,
  Undo2,
  ChevronUp,
  ChevronDown,
  Copy,
  MessageSquare,
  Paperclip,
  Archive,
  ArchiveRestore,
} from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import {
  PRIORITY_BADGE,
  PRIORITY_LABEL,
  REMINDER_PRIORITIES,
  type ReminderPriority,
} from '@/lib/reminder-priority';
import {
  markReminderDoneAction,
  reopenReminderAction,
  setReminderPriorityAction,
  cloneReminderAction,
  archiveReminderAction,
  restoreReminderAction,
} from '../clients/[id]/reminders/actions';
import type { ReminderRow, ReminderScope, ReminderStatus } from '@/server/reminders/queries';
import { inZweiWochen } from './[id]/ticket-forms';

const UNDO_WINDOW_MS = 10_000;

/** REMINDER-TICKET-001: Die Liste zeigt genau den serverseitig gefilterten Zustand. */
export function RemindersOverview({
  scope,
  status,
  currentStaffId,
  rows,
  canPrioritizeAll = false,
}: {
  scope: ReminderScope;
  status: ReminderStatus;
  currentStaffId: string;
  rows: ReminderRow[];
  canPrioritizeAll?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [undoBar, setUndoBar] = useState<{ id: string; subject: string } | null>(null);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  function run(action: () => Promise<{ ok: boolean; error?: string }>, onSuccess?: () => void) {
    setError(null);
    start(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error ?? 'Aktion fehlgeschlagen.');
          return;
        }
        onSuccess?.();
        router.refresh();
      } catch {
        setError('Aktion fehlgeschlagen. Bitte erneut versuchen.');
      }
    });
  }
  function reopen(id: string) {
    run(
      () => reopenReminderAction({ id }),
      () => setUndoBar((current) => (current?.id === id ? null : current)),
    );
  }
  function markDone(row: ReminderRow) {
    run(
      () => markReminderDoneAction({ id: row.id }),
      () => {
        const undo = { id: row.id, subject: `#${row.ticketNumber} ${row.subject}` };
        setUndoBar(undo);
        window.setTimeout(
          () => setUndoBar((current) => (current === undo ? null : current)),
          UNDO_WINDOW_MS,
        );
      },
    );
  }
  return (
    <div>
      {error && (
        <p role="alert" className="alert-error-sm m-4">
          {error}
        </p>
      )}
      {undoBar && (
        <div
          role="status"
          className="m-4 flex items-center gap-3 rounded border border-default bg-surface-raised p-3 text-xs"
        >
          <Check className="h-4 w-4" />
          <span className="flex-1">
            Erledigt: <strong>{undoBar.subject}</strong>
          </span>
          <button
            type="button"
            onClick={() => reopen(undoBar.id)}
            disabled={pending}
            className="btn-secondary text-xs"
          >
            <Undo2 className="h-3 w-3" />
            Rückgängig
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="p-6 text-sm text-muted text-center">
          {status === 'archived'
            ? 'Keine archivierten Tickets.'
            : status === 'done'
              ? 'Keine erledigten Tickets.'
              : scope === 'mir'
                ? 'Keine offenen Tickets an dich.'
                : 'Keine offenen Tickets.'}
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {rows.map((row) => {
            const archived = Boolean(row.archivedAt);
            const done = Boolean(row.doneAt);
            const canSteer = canPrioritizeAll || row.createdByStaff === currentStaffId;
            const badge = PRIORITY_BADGE[row.priority];
            const overdue = !done && !archived && new Date(row.dueDate) < today;
            return (
              <li key={row.id} className="p-4 flex gap-3 items-start">
                {!done && !archived ? (
                  <button
                    type="button"
                    onClick={() => markDone(row)}
                    disabled={pending}
                    className="mt-1 w-5 h-5 rounded border-2 border-strong text-transparent hover:text-emerald-600 hover:border-emerald-600 shrink-0"
                    title="Als erledigt markieren"
                    aria-label={`Ticket #${row.ticketNumber} als erledigt markieren`}
                  >
                    <Check className="h-4 w-4" />
                  </button>
                ) : (
                  <span className="mt-1 text-disabled">
                    {archived ? <Archive className="h-5 w-5" /> : <Check className="h-5 w-5" />}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/staff/reminders/${row.ticketNumber}`}
                      className="font-medium text-sm text-primary hover:underline break-words"
                    >
                      <span className="text-muted">#{row.ticketNumber}</span> {row.subject}
                    </Link>
                    {badge && (
                      <span className={`${badge} text-[11px]`}>{PRIORITY_LABEL[row.priority]}</span>
                    )}
                    {row.noteCount > 0 && (
                      <span className="text-xs text-muted inline-flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        {row.noteCount} Kommentare
                      </span>
                    )}
                    {row.attachmentCount > 0 && (
                      <span className="text-xs text-muted inline-flex items-center gap-1">
                        <Paperclip className="h-3 w-3" />
                        {row.attachmentCount} Anhänge
                      </span>
                    )}
                  </div>
                  <TicketRowContext row={row} overdue={overdue} />
                  {done && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {!archived && (
                        <button
                          type="button"
                          onClick={() => reopen(row.id)}
                          disabled={pending}
                          className="btn-secondary text-xs"
                        >
                          <Undo2 className="h-3 w-3" />
                          Zurückholen
                        </button>
                      )}
                      {row.canArchive && (
                        <button
                          type="button"
                          onClick={() => run(() => archiveReminderAction({ id: row.id }))}
                          disabled={pending}
                          className="btn-secondary text-xs"
                        >
                          <Archive className="h-3 w-3" />
                          Archivieren
                        </button>
                      )}
                      {row.canRestore && (
                        <button
                          type="button"
                          onClick={() => run(() => restoreReminderAction({ id: row.id }))}
                          disabled={pending}
                          className="btn-secondary text-xs"
                        >
                          <ArchiveRestore className="h-3 w-3" />
                          Wiederherstellen
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          run(() =>
                            cloneReminderAction({
                              id: row.id,
                              alsNachfrage: false,
                              dueDate: inZweiWochen(),
                            }),
                          )
                        }
                        disabled={pending}
                        className="btn-secondary text-xs"
                      >
                        <Copy className="h-3 w-3" />
                        Klonen
                      </button>
                    </div>
                  )}
                </div>
                {!done && !archived && canSteer && (
                  <PriorityControl
                    value={row.priority}
                    pending={pending}
                    onChange={(priority) =>
                      run(() => setReminderPriorityAction({ id: row.id, priority }))
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
/**
 * Priorität hoch-/runterstufen. Bewusst zwei Pfeile statt eines Dropdowns:
 * „bumpen" ist die eigentliche Handlung, und sie soll ein Klick sein.
 */
function PriorityControl({
  value,
  pending,
  onChange,
}: {
  value: ReminderPriority;
  pending: boolean;
  onChange: (p: ReminderPriority) => void;
}) {
  const i = REMINDER_PRIORITIES.indexOf(value);
  const hoeher = REMINDER_PRIORITIES[i + 1] ?? null;
  const niedriger = REMINDER_PRIORITIES[i - 1] ?? null;
  return (
    <div className="flex flex-col items-center shrink-0">
      <button
        type="button"
        onClick={() => hoeher && onChange(hoeher)}
        disabled={pending || !hoeher}
        title={hoeher ? `Auf „${PRIORITY_LABEL[hoeher]}" anheben` : 'Bereits höchste Priorität'}
        className="text-disabled hover:text-red-600 disabled:opacity-30 p-0.5"
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <span className="text-[10px] text-muted">{PRIORITY_LABEL[value]}</span>
      <button
        type="button"
        onClick={() => niedriger && onChange(niedriger)}
        disabled={pending || !niedriger}
        title={
          niedriger ? `Auf „${PRIORITY_LABEL[niedriger]}" senken` : 'Bereits niedrigste Priorität'
        }
        className="text-disabled hover:text-brand-600 disabled:opacity-30 p-0.5"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}

function TicketRowContext({ row, overdue }: { row: ReminderRow; overdue: boolean }) {
  return (
    <>
      <p className="text-xs text-muted mt-1">
        {row.clientId ? (
          <Link href={`/staff/clients/${row.clientId}`} className="hover:underline">
            {row.clientName}
          </Link>
        ) : (
          'Intern'
        )}
        {' · '}
        <span className={overdue ? 'text-red-700 font-medium' : undefined}>
          fällig {fmtDateShort(new Date(row.dueDate))}
          {overdue ? ' · überfällig' : ''}
        </span>
        {row.assigneeNames.length > 0 && ` · ${row.assigneeNames.join(', ')}`}
        {row.createdByName && ` · von ${row.createdByName}`}
      </p>
      {row.begriff && (
        <p className="text-xs text-muted mt-1">
          Recherche: {row.begriff}
          {row.normAnker.length > 0 ? ` · ${row.normAnker.join(', ')}` : ''}
        </p>
      )}
      {row.auftrag && (
        <p className="text-xs text-secondary mt-1 line-clamp-2 whitespace-pre-wrap">
          {row.auftrag}
        </p>
      )}
    </>
  );
}
