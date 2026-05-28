'use client';

import { useActionState, useRef, useEffect } from 'react';
import { createVacationRequestAction, type ActionResult } from './actions';

export function VacationForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createVacationRequestAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="vac-startDate">Von</label>
          <input id="vac-startDate" name="startDate" type="date" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="vac-endDate">Bis</label>
          <input id="vac-endDate" name="endDate" type="date" className="input" required />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="vac-reason">Grund (optional)</label>
        <textarea id="vac-reason" name="reason" rows={2} className="input" maxLength={1000} />
      </div>
      {state?.error && (
        <div className="alert-error-sm">{state.error}</div>
      )}
      {state?.ok && (
        <div className="alert-success-sm">Antrag gestellt.</div>
      )}
      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        {isPending ? 'Sendet…' : 'Antrag stellen'}
      </button>
    </form>
  );
}
