'use client';

import { useActionState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { completeDailyReviewAction, type DailyReviewActionResult } from './actions';

export function DailyReviewForm({ openCount }: { openCount: number }) {
  const [state, formAction, isPending] = useActionState<DailyReviewActionResult | null, FormData>(
    completeDailyReviewAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-3">
      {openCount > 0 ? (
        <div>
          <label htmlFor="daily-review-escalation" className="label">
            Eskalationsnotiz
          </label>
          <textarea
            id="daily-review-escalation"
            name="escalationNote"
            rows={3}
            minLength={3}
            maxLength={4000}
            required
            className="input w-full"
            placeholder="Wie werden die offenen Fälligkeiten nachverfolgt, wer übernimmt und bis wann?"
          />
          <p className="mt-1 text-xs text-muted">
            Pflichtangabe, solange heute fällige oder überfällige Fristen offen sind.
          </p>
        </div>
      ) : (
        <p className="text-sm text-secondary">
          Aktuell sind keine heute fälligen oder überfälligen Fristen offen.
        </p>
      )}

      <button type="submit" disabled={isPending} className="btn-primary disabled:opacity-60">
        <CheckCircle2 className="h-4 w-4" />
        {isPending ? 'Dokumentiere …' : 'Tageskontrolle abschließen'}
      </button>

      {state && !state.ok && (
        <p className="alert-error-sm" role="alert">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="text-sm text-green-700 dark:text-green-300" aria-live="polite">
          Abschlusskontrolle wurde unveränderbar dokumentiert.
        </p>
      )}
    </form>
  );
}
