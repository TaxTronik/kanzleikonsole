'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Check, Plus, Trash2, Send } from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import {
  createReminderAction,
  markReminderDoneAction,
  deleteReminderAction,
  submitResearchResultAction,
} from './actions';
import type { ActionResult } from '@/server/actions/staff-action';

interface Reminder {
  id: string;
  dueDate: string; // ISO
  subject: string;
  notes: string | null;
  doneAt: string | null;
  assigneeName: string | null;
  /** Markierungs-ID, falls diese Wiedervorlage eine Risiko-Recherche-Delegation
   *  ist (→ „Ergebnis einreichen"-Affordance). Sonst null. */
  researchMarkingId: string | null;
}

interface StaffOption {
  id: string;
  fullName: string;
}

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
  const [submitFor, setSubmitFor] = useState<string | null>(null);
  const [resultBody, setResultBody] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  function markDone(id: string) {
    startMut(async () => {
      await markReminderDoneAction({ id });
      router.refresh();
    });
  }
  function submitResult(reminderId: string) {
    startMut(async () => {
      const res = await submitResearchResultAction({ reminderId, clientId, body: resultBody });
      if (res.ok) {
        setSubmitFor(null);
        setResultBody('');
        setSubmitError(null);
        router.refresh();
      } else setSubmitError(res.error ?? 'Konnte nicht eingereicht werden.');
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-disabled" />
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
        <form
          action={formAction}
          className="p-4 border-b border-default bg-gray-50/50 dark:bg-gray-900/30 space-y-2"
        >
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
            <select
              name="assigneeStaffId"
              defaultValue={currentStaffId}
              className="input text-sm flex-1"
            >
              <option value="">— niemand zugewiesen —</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
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
        <p className="px-6 py-6 text-sm text-disabled text-center">Keine offenen Wiedervorlagen.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {open_items.map((r) => {
            const due = new Date(r.dueDate);
            const overdue = due.getTime() < today.getTime();
            return (
              <li key={r.id} className="px-6 py-3 flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => markDone(r.id)}
                  disabled={isMutating}
                  className="mt-0.5 w-5 h-5 rounded border-2 border-strong hover:border-emerald-600 hover:bg-emerald-50 flex items-center justify-center text-transparent hover:text-emerald-600 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/20 shrink-0"
                  title="Als erledigt markieren"
                >
                  <Check className="h-3 w-3" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-primary">{r.subject}</p>
                  <p
                    className={overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-muted'}
                  >
                    fällig {fmtDateShort(due)}
                    {overdue && ' · überfällig'}
                    {r.assigneeName && (
                      <span className="ml-2 text-disabled">· {r.assigneeName}</span>
                    )}
                  </p>
                  {r.notes && (
                    <p className="text-xs text-secondary mt-1 whitespace-pre-wrap">{r.notes}</p>
                  )}
                  {r.researchMarkingId &&
                    (submitFor === r.id ? (
                      <div className="mt-2 space-y-1.5">
                        <textarea
                          value={resultBody}
                          onChange={(e) => setResultBody(e.target.value)}
                          rows={4}
                          maxLength={100_000}
                          placeholder="Dein Rechercheergebnis (Fundstellen, Einschätzung) …"
                          className="input text-sm w-full"
                          autoFocus
                        />
                        {submitError && <p className="text-xs text-red-700">{submitError}</p>}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => submitResult(r.id)}
                            disabled={isMutating || !resultBody.trim()}
                            className="btn-primary text-xs"
                          >
                            <Send className="h-3 w-3" /> Ergebnis einreichen
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSubmitFor(null);
                              setResultBody('');
                              setSubmitError(null);
                            }}
                            disabled={isMutating}
                            className="btn-secondary text-xs"
                          >
                            Abbrechen
                          </button>
                        </div>
                        <p className="text-[11px] text-muted">
                          Wird der Markierung im Recherche-Hub zugeordnet und erledigt diese
                          Wiedervorlage.
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setSubmitFor(r.id);
                          setResultBody('');
                          setSubmitError(null);
                        }}
                        className="mt-1.5 text-xs text-brand-600 hover:underline inline-flex items-center gap-1"
                      >
                        <Send className="h-3 w-3" /> Ergebnis einreichen
                      </button>
                    ))}
                </div>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  disabled={isMutating}
                  className="text-disabled hover:text-red-700 p-1 shrink-0"
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
        <details className="border-t border-default">
          <summary className="px-6 py-2 text-xs text-muted cursor-pointer">
            {done_items.length} erledigt
          </summary>
          <ul className="divide-y divide-border-subtle">
            {done_items.map((r) => (
              <li key={r.id} className="px-6 py-2 text-sm text-muted line-through">
                {r.subject} · {fmtDateShort(new Date(r.dueDate))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
