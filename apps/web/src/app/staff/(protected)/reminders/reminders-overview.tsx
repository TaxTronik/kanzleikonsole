'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, Undo2, ChevronUp, ChevronDown, Quote } from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import {
  PRIORITY_BADGE,
  PRIORITY_LABEL,
  REMINDER_PRIORITIES,
  byPriorityThenDue,
  type ReminderPriority,
} from '@/lib/reminder-priority';
import {
  markReminderDoneAction,
  reopenReminderAction,
  setReminderPriorityAction,
} from '../clients/[id]/reminders/actions';
import type { ReminderRow, ReminderScope } from '@/server/reminders/queries';

/** Muss zu REMINDER_DONE_NOTIFY_DELAY_MS im Queue-Modul passen. */
const UNDO_WINDOW_MS = 10_000;

export function RemindersOverview({
  scope,
  currentStaffId,
  offen,
  erledigt,
  canPrioritizeAll = false,
}: {
  scope: ReminderScope;
  currentStaffId: string;
  offen: ReminderRow[];
  erledigt: ReminderRow[];
  /** Admin/Partner darf jede Priorität ändern, nicht nur die eigener Aufträge. */
  canPrioritizeAll?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Gerade erledigt — bleibt für das Rücknahme-Fenster sichtbar. Solange der
  // Eintrag hier steht, ist auch die Rückmeldung an die delegierende Person
  // noch nicht raus (verzögerter Job).
  const [undoBar, setUndoBar] = useState<{ id: string; subject: string } | null>(null);

  const sortiert = useMemo(() => [...offen].sort(byPriorityThenDue), [offen]);
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  function erledigen(r: ReminderRow) {
    setError(null);
    start(async () => {
      const res = await markReminderDoneAction({ id: r.id });
      if (!res.ok) {
        setError(res.error ?? 'Konnte nicht erledigt werden.');
        return;
      }
      setUndoBar({ id: r.id, subject: r.subject });
      window.setTimeout(() => {
        setUndoBar((cur) => (cur?.id === r.id ? null : cur));
      }, UNDO_WINDOW_MS);
      router.refresh();
    });
  }

  function zurueckholen(id: string) {
    setError(null);
    start(async () => {
      const res = await reopenReminderAction({ id });
      if (!res.ok) {
        setError(res.error ?? 'Konnte nicht zurückgeholt werden.');
        return;
      }
      setUndoBar((cur) => (cur?.id === id ? null : cur));
      router.refresh();
    });
  }

  function priorisieren(id: string, priority: ReminderPriority) {
    setError(null);
    start(async () => {
      const res = await setReminderPriorityAction({ id, priority });
      if (!res.ok) setError(res.error ?? 'Priorität konnte nicht geändert werden.');
      else router.refresh();
    });
  }

  const darfPriorisieren = (r: ReminderRow) =>
    canPrioritizeAll || r.createdByStaff === currentStaffId;

  return (
    <div className="space-y-4">
      {error && <p className="alert-error-sm">{error}</p>}

      {undoBar && (
        <div className="flex items-center gap-3 rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/25 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
          <Check className="h-4 w-4 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Erledigt: <strong>{undoBar.subject}</strong>
          </span>
          <button
            type="button"
            onClick={() => zurueckholen(undoBar.id)}
            disabled={pending}
            className="btn-secondary text-xs shrink-0"
          >
            <Undo2 className="h-3.5 w-3.5" /> Rückgängig
          </button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="card-header">
          <h2 className="text-sm font-medium text-primary">Offen ({sortiert.length})</h2>
        </div>
        {sortiert.length === 0 ? (
          <p className="px-6 py-10 text-sm text-disabled text-center">
            {scope === 'mir'
              ? 'Nichts offen — dir ist gerade nichts zugewiesen.'
              : 'Du hast aktuell nichts delegiert, das noch offen wäre.'}
          </p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {sortiert.map((r) => {
              const due = new Date(r.dueDate);
              const overdue = due.getTime() < today.getTime();
              const badge = PRIORITY_BADGE[r.priority];
              return (
                <li key={r.id} className="px-6 py-3 flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => erledigen(r)}
                    disabled={pending}
                    title="Als erledigt markieren"
                    className="mt-0.5 w-5 h-5 rounded border-2 border-strong hover:border-emerald-600 hover:bg-emerald-50 flex items-center justify-center text-transparent hover:text-emerald-600 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/20 shrink-0"
                  >
                    <Check className="h-3 w-3" />
                  </button>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/staff/clients/${r.clientId}`}
                        className="text-sm text-primary hover:underline"
                      >
                        {r.subject}
                      </Link>
                      {badge && (
                        <span className={`${badge} text-[11px]`}>{PRIORITY_LABEL[r.priority]}</span>
                      )}
                    </div>

                    <p
                      className={
                        overdue ? 'text-xs text-red-700 font-medium' : 'text-xs text-muted'
                      }
                    >
                      {r.clientName} · fällig {fmtDateShort(due)}
                      {overdue && ' · überfällig'}
                      {scope === 'mir' && r.createdByName && (
                        <span className="ml-2 text-disabled">· von {r.createdByName}</span>
                      )}
                      {scope === 'vonmir' && r.assigneeName && (
                        <span className="ml-2 text-disabled">· bei {r.assigneeName}</span>
                      )}
                    </p>

                    {(r.begriff || r.normAnker.length > 0) && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.begriff && <span className="badge-yellow text-[11px]">{r.begriff}</span>}
                        {r.normAnker.map((n) => (
                          <span key={n} className="badge-gray text-[11px] font-mono">
                            {n}
                          </span>
                        ))}
                      </div>
                    )}
                    {r.auftrag && (
                      <blockquote className="flex gap-1.5 rounded border-l-2 border-strong bg-surface-raised px-2 py-1 text-xs text-secondary">
                        <Quote className="h-3 w-3 shrink-0 mt-0.5 text-disabled" />
                        <span className="min-w-0 break-words whitespace-pre-wrap">{r.auftrag}</span>
                      </blockquote>
                    )}
                    {r.researchAnalysisId && r.researchMarkingId && (
                      <Link
                        href={`/staff/clients/${r.clientId}/subsumtion/${r.researchAnalysisId}?marking=${r.researchMarkingId}`}
                        className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1"
                      >
                        Markierung im Subsumtions-Space öffnen
                      </Link>
                    )}
                  </div>

                  {darfPriorisieren(r) && (
                    <PriorityControl
                      value={r.priority}
                      pending={pending}
                      onChange={(p) => priorisieren(r.id, p)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {erledigt.length > 0 && (
        <details className="card overflow-hidden">
          <summary className="card-header cursor-pointer text-sm text-muted">
            {erledigt.length} erledigt — zum Zurückholen aufklappen
          </summary>
          <ul className="divide-y divide-border-subtle">
            {erledigt.map((r) => (
              <li key={r.id} className="px-6 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-muted line-through truncate">{r.subject}</p>
                  <p className="text-[11px] text-disabled">
                    {r.clientName} · erledigt {r.doneAt ? fmtDateShort(new Date(r.doneAt)) : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => zurueckholen(r.id)}
                  disabled={pending}
                  className="btn-secondary text-xs shrink-0"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Zurückholen
                </button>
              </li>
            ))}
          </ul>
        </details>
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
