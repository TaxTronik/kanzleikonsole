'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, Plus, Trash2 } from 'lucide-react';
import {
  createReminderAction,
  markReminderDoneAction,
  deleteReminderAction,
  type ActionResult,
} from './actions';

const dateFmt = new Intl.DateTimeFormat('de-DE');

interface Reminder {
  id: string;
  dueDate: string; // ISO
  subject: string;
  notes: string | null;
  doneAt: string | null;
  assigneeName: string | null;
}

interface StaffOption { id: string; fullName: string; }

export function RemindersBlock({
  clientId,
  initial,
  staffOptions,
  currentStaffId,
}: {
  clientId: string;
  initial: Reminder[];
  staffOptions: StaffOption[];
  currentStaffId: string;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createReminderAction,
    null,
  );
  const [isMutating, startMut] = useTransition();
  const [open, setOpen] = useState(false);

  function markDone(id: string) {
    startMut(async () => {
      await markReminderDoneAction({ id });
      router.refresh();
    });
  }
  function remove(id: string) {
    if (!confirm('Wiedervorlage löschen?')) return;
    startMut(async () => {
      await deleteReminderAction({ id });
      router.refresh();
    });
  }

  const open_items = initial.filter((r) => !r.doneAt);
  const done_items = initial.filter((r) => r.doneAt);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-gray-400" />
          Wiedervorlagen ({open_items.length})
        </h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="btn-secondary text-xs inline-flex items-center gap-1"
        >
          <Plus className="h-3 w-3" />
          Neu
        </button>
      </div>

      {open && (
        <form action={formAction} className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/30 space-y-2">
          <input type="hidden" name="clientId" value={clientId} />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="date"
              name="dueDate"
              className="input text-sm"
              min={new Date().toISOString().slice(0, 10)}
              required
            />
            <input
              type="text"
              name="subject"
              placeholder='Stichwort — z. B. „nach Urlaub anrufen"'
              className="input text-sm col-span-2"
              maxLength={200}
              required
            />
          </div>
          <textarea
            name="notes"
            placeholder="Optionale Notiz"
            rows={2}
            maxLength={2000}
            className="input text-sm"
          />
          <div className="flex items-center gap-2">
            <select name="assigneeStaffId" defaultValue={currentStaffId} className="input text-sm flex-1">
              <option value="">— niemand zugewiesen —</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.fullName}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={isPending}
              className="btn-secondary text-xs"
            >
              Abbrechen
            </button>
            <button type="submit" disabled={isPending} className="btn-primary text-xs">
              {isPending ? 'Lege an…' : 'Anlegen'}
            </button>
          </div>
          {state && !state.ok && <p className="text-xs text-red-700">{state.error}</p>}
        </form>
      )}

      {open_items.length === 0 ? (
        <p className="px-6 py-6 text-sm text-gray-400 text-center">Keine offenen Wiedervorlagen.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {open_items.map((r) => {
            const due = new Date(r.dueDate);
            const overdue = due.getTime() < today.getTime();
            return (
              <li key={r.id} className="px-6 py-3 flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => markDone(r.id)}
                  disabled={isMutating}
                  className="mt-0.5 w-5 h-5 rounded border-2 border-gray-300 hover:border-emerald-600 hover:bg-emerald-50 flex items-center justify-center text-transparent hover:text-emerald-600 dark:border-gray-600 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/20 shrink-0"
                  title="Als erledigt markieren"
                >
                  <Check className="h-3 w-3" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 dark:text-gray-100">{r.subject}</p>
                  <p className={overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-gray-500'}>
                    fällig {dateFmt.format(due)}
                    {overdue && ' · überfällig'}
                    {r.assigneeName && <span className="ml-2 text-gray-400">· {r.assigneeName}</span>}
                  </p>
                  {r.notes && (
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 whitespace-pre-wrap">{r.notes}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  disabled={isMutating}
                  className="text-gray-400 hover:text-red-700 p-1 shrink-0"
                  title="Löschen"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {done_items.length > 0 && (
        <details className="border-t border-gray-200 dark:border-gray-800">
          <summary className="px-6 py-2 text-xs text-gray-500 cursor-pointer">
            {done_items.length} erledigt
          </summary>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {done_items.map((r) => (
              <li key={r.id} className="px-6 py-2 text-sm text-gray-500 line-through">
                {r.subject} · {dateFmt.format(new Date(r.dueDate))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
