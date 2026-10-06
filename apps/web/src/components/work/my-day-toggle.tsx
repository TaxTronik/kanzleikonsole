'use client';

import { useId, useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { type CompletionAction, myDayCompletionError } from './my-day-completion';

/** Erledigen-Haken für Workflow-Aufgaben in „Mein Tag“ und im Arbeitskorb. */
export function MyDayToggle({ id, complete }: { id: string; complete: CompletionAction }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const errorId = useId();

  function toggle() {
    setDone(true);
    setError(null);
    start(async () => {
      const nextError = await myDayCompletionError(id, complete);
      if (nextError) {
        // Optimistische Darstellung bei Server-/Berechtigungsfehlern
        // zurueckrollen; sonst behauptet der Arbeitskorb eine Erledigung, die
        // nie persistiert wurde.
        setDone(false);
        setError(nextError);
      }
    });
  }

  return (
    <span className="mt-0.5 shrink-0">
      <button
        type="button"
        onClick={toggle}
        disabled={isPending || done}
        className={
          done
            ? 'w-6 h-6 rounded border-2 border-emerald-600 bg-emerald-600 text-white flex items-center justify-center'
            : 'w-6 h-6 rounded border-2 border-strong hover:border-emerald-600'
        }
        aria-label="Als erledigt markieren"
        aria-describedby={error ? errorId : undefined}
        title="Als erledigt markieren"
      >
        {done && <Check className="h-3 w-3" />}
      </button>
      {error && (
        <span id={errorId} role="alert" className="sr-only">
          {error}
        </span>
      )}
    </span>
  );
}
