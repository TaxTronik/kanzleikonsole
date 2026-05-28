'use client';

import { useActionState, useRef, useEffect } from 'react';
import { createSickLeaveAction, type ActionResult } from './actions';

export function SickForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createSickLeaveAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="sick-startDate">Erster Krankheitstag</label>
          <input id="sick-startDate" name="startDate" type="date" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="sick-endDate">Letzter (optional)</label>
          <input id="sick-endDate" name="endDate" type="date" className="input" />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="sick-notes">Notizen (optional)</label>
        <textarea id="sick-notes" name="notes" rows={2} className="input" maxLength={1000} />
      </div>
      {state?.error && (
        <div className="alert-error-sm">{state.error}</div>
      )}
      {state?.ok && (
        <div className="alert-success-sm">Eingetragen.</div>
      )}
      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Krankmeldung speichern'}
      </button>
    </form>
  );
}
