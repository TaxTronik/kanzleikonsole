'use client';

import { useActionState, useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CalendarClock,
  Check,
  Plus,
  Trash2,
  Send,
  UserCheck,
  Quote,
  Undo2,
  ChevronUp,
} from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { parseDelegationNotes } from '@/server/risk/delegate-notes';
import { onNotificationsGrew } from '@/lib/live-events';
import {
  PRIORITY_BADGE,
  PRIORITY_LABEL,
  REMINDER_PRIORITIES,
  type ReminderPriority,
} from '@/lib/reminder-priority';
import {
  createReminderAction,
  markReminderDoneAction,
  reopenReminderAction,
  setReminderPriorityAction,
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
  assigneeNames: string[];
  /** Markierungs-ID, falls diese Wiedervorlage eine Risiko-Recherche-Delegation
   *  ist (→ „Ergebnis einreichen"-Affordance). Sonst null. */
  researchMarkingId: string | null;
  /** Analyse der Markierung — für den Sprung in den Subsumtions-Space. */
  researchAnalysisId: string | null;
  createdByStaff: string;
  createdByName: string | null;
  assigneeStaffIds: string[];
  priority: ReminderPriority;
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
  // Nach dem Anlegen schliessen + neu laden. `revalidatePath` allein liess die
  // Liste stehen; der explizite Refresh macht das Ergebnis sofort sichtbar.
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);
  const [submitFor, setSubmitFor] = useState<string | null>(null);
  const [resultBody, setResultBody] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Serverdaten (initial) plus per Live-Nachladen aktualisierte Fassung.
  const [live, setLive] = useState<Reminder[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Gerade erledigt — Rücknahme-Balken für das Fenster, in dem die Rückmeldung
  // an die delegierende Person noch nicht raus ist.
  const [undoBar, setUndoBar] = useState<{ id: string; subject: string } | null>(null);

  // Die Mandantenseite ist vom Bell-getriebenen Voll-Refresh ausgenommen (zu
  // teuer). Damit eine frisch delegierte Wiedervorlage trotzdem ohne manuellen
  // Reload erscheint, laedt NUR dieser Block seine Daten nach — und auch das
  // nur, wenn die Benachrichtigung DIESEN Mandanten betrifft (Filter im
  // Abonnement). Eine Meldung zu einem anderen Mandanten kostet hier nichts.
  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/staff/clients/${clientId}/reminders`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { items: Reminder[] };
      setLive(data.items);
    } catch {
      /* still — beim naechsten Ereignis erneut */
    } finally {
      setRefreshing(false);
    }
  }, [clientId]);

  useEffect(() => onNotificationsGrew(() => void reload(), { clientId }), [reload, clientId]);
  // Neue Server-Props (revalidatePath/refresh) gewinnen wieder.
  useEffect(() => setLive(null), [initial]);

  function markDone(id: string, subject: string) {
    startMut(async () => {
      const res = await markReminderDoneAction({ id });
      if (!res.ok) return;
      setUndoBar({ id, subject });
      window.setTimeout(() => setUndoBar((c) => (c?.id === id ? null : c)), UNDO_WINDOW_MS);
      router.refresh();
    });
  }
  function reopen(id: string) {
    startMut(async () => {
      await reopenReminderAction({ id });
      setUndoBar((c) => (c?.id === id ? null : c));
      router.refresh();
    });
  }
  function bump(id: string, priority: ReminderPriority) {
    startMut(async () => {
      await setReminderPriorityAction({ id, priority });
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

  const rows = live ?? initial;
  const open_items = rows.filter((r) => !r.doneAt);
  const done_items = rows.filter((r) => r.doneAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
          <CalendarClock className={`h-4 w-4 text-disabled${refreshing ? ' animate-pulse' : ''}`} />
          Wiedervorlagen ({open_items.length})
          {refreshing && (
            <span className="text-[11px] font-normal text-disabled animate-pulse">
              wird aktualisiert …
            </span>
          )}
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
              multiple
              name="assigneeStaffIds"
              defaultValue={[currentStaffId]}
              size={Math.min(4, Math.max(2, staffOptions.length))}
              className="input text-sm flex-1"
              title="Mehrfachauswahl mit Strg/Cmd — alle teilen sich EINE Aufgabe"
            >
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

      {undoBar && (
        <div className="mx-6 mt-3 flex items-center gap-3 rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/25 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-100">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Erledigt: <strong>{undoBar.subject}</strong>
          </span>
          <button
            type="button"
            onClick={() => reopen(undoBar.id)}
            disabled={isMutating}
            className="btn-secondary text-xs shrink-0"
          >
            <Undo2 className="h-3 w-3" /> Rückgängig
          </button>
        </div>
      )}

      {open_items.length === 0 ? (
        <p className="px-6 py-6 text-sm text-disabled text-center">Keine offenen Wiedervorlagen.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {open_items.map((r) => {
            const due = new Date(r.dueDate);
            const overdue = due.getTime() < today.getTime();
            // Delegation = Recherche-Auftrag an jemand anderen. „an mich" wird
            // hervorgehoben, „von mir an X" nur benannt — sonst sieht jede
            // Wiedervorlage gleich aus und der Auftrag geht in der Liste unter.
            const delegiert = r.researchMarkingId != null;
            const anMich = delegiert && r.assigneeStaffIds.includes(currentStaffId);
            const vonMir = delegiert && r.createdByStaff === currentStaffId && !anMich;
            const ctx = delegiert ? parseDelegationNotes(r.notes) : null;
            return (
              <li
                key={r.id}
                className={
                  anMich
                    ? 'px-6 py-3 flex items-start gap-3 border-l-2 border-brand-500 bg-brand-50/40 dark:bg-brand-900/10'
                    : 'px-6 py-3 flex items-start gap-3'
                }
              >
                <button
                  type="button"
                  onClick={() => markDone(r.id, r.subject)}
                  disabled={isMutating}
                  className="mt-0.5 w-5 h-5 rounded border-2 border-strong hover:border-emerald-600 hover:bg-emerald-50 flex items-center justify-center text-transparent hover:text-emerald-600 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/20 shrink-0"
                  title="Als erledigt markieren"
                >
                  <Check className="h-3 w-3" />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm text-primary">{r.subject}</p>
                    {anMich && (
                      <span className="badge-brand text-[11px] inline-flex items-center gap-1">
                        <UserCheck className="h-3 w-3" /> an mich delegiert
                      </span>
                    )}
                    {vonMir && r.assigneeNames.length > 0 && (
                      <span className="badge-gray text-[11px]">
                        delegiert an {r.assigneeNames.join(', ')}
                      </span>
                    )}
                    {PRIORITY_BADGE[r.priority] && (
                      <span className={`${PRIORITY_BADGE[r.priority]} text-[11px]`}>
                        {PRIORITY_LABEL[r.priority]}
                      </span>
                    )}
                    {r.createdByStaff === currentStaffId && naechsteStufe(r.priority) && (
                      <button
                        type="button"
                        onClick={() => bump(r.id, naechsteStufe(r.priority)!)}
                        disabled={isMutating}
                        title={`Priorität auf „${PRIORITY_LABEL[naechsteStufe(r.priority)!]}" anheben`}
                        className="text-disabled hover:text-red-600 disabled:opacity-40"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p
                    className={overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-muted'}
                  >
                    fällig {fmtDateShort(due)}
                    {overdue && ' · überfällig'}
                    {r.assigneeNames.length > 0 && !vonMir && (
                      <span className="ml-2 text-disabled">· {r.assigneeNames.join(', ')}</span>
                    )}
                    {anMich && r.createdByName && (
                      <span className="ml-2 text-disabled">· von {r.createdByName}</span>
                    )}
                  </p>

                  {ctx ? (
                    <div className="mt-1.5 space-y-1.5">
                      {(ctx.begriff || ctx.normAnker.length > 0) && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {ctx.begriff && (
                            <span className="badge-yellow text-[11px]">{ctx.begriff}</span>
                          )}
                          {ctx.normAnker.map((n) => (
                            <span key={n} className="badge-gray text-[11px] font-mono">
                              {n}
                            </span>
                          ))}
                        </div>
                      )}
                      {ctx.fundstelle && (
                        <blockquote className="flex gap-1.5 rounded border-l-2 border-strong bg-surface-raised px-2 py-1 text-xs text-secondary italic">
                          <Quote className="h-3 w-3 shrink-0 mt-0.5 text-disabled" />
                          <span className="min-w-0 break-words">{ctx.fundstelle}</span>
                        </blockquote>
                      )}
                      {ctx.auftrag && (
                        <p className="text-xs text-secondary whitespace-pre-wrap">{ctx.auftrag}</p>
                      )}
                      {ctx.rest.length > 0 && (
                        <p className="text-xs text-secondary whitespace-pre-wrap">
                          {ctx.rest.join('\n')}
                        </p>
                      )}
                      {r.researchAnalysisId && (
                        <Link
                          href={`/staff/clients/${clientId}/subsumtion/${r.researchAnalysisId}?marking=${r.researchMarkingId}`}
                          className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1"
                        >
                          Markierung im Subsumtions-Space öffnen
                        </Link>
                      )}
                    </div>
                  ) : (
                    r.notes && (
                      <p className="text-xs text-secondary mt-1 whitespace-pre-wrap">{r.notes}</p>
                    )
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
              <li key={r.id} className="px-6 py-2 flex items-center gap-3">
                <span className="flex-1 min-w-0 truncate text-sm text-muted line-through">
                  {r.subject} · {fmtDateShort(new Date(r.dueDate))}
                </span>
                <button
                  type="button"
                  onClick={() => reopen(r.id)}
                  disabled={isMutating}
                  title="Wiedervorlage zurückholen"
                  className="text-disabled hover:text-brand-600 disabled:opacity-40 shrink-0"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Muss zu REMINDER_DONE_NOTIFY_DELAY_MS im Queue-Modul passen. */
const UNDO_WINDOW_MS = 10_000;

/** Naechsthoehere Stufe oder null (bereits „Dringend"). */
function naechsteStufe(p: ReminderPriority): ReminderPriority | null {
  return REMINDER_PRIORITIES[REMINDER_PRIORITIES.indexOf(p) + 1] ?? null;
}
