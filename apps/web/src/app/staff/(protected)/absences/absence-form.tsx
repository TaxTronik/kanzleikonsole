'use client';

import { useActionState, useRef, useEffect, useState } from 'react';
import { reportAbsenceAction, type ActionResult } from './actions';

// iter87: generische Abwesenheitsmeldung (krank / sonstige). Der Grund ist
// vertraulich — sichtbar nur für die meldende Person und Entscheidungsträger;
// Kalender zeigen nur „abw.".
export function AbsenceForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<'SICKNESS' | 'OTHER'>('SICKNESS');
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    reportAbsenceAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="absence-kind">
          Art
        </label>
        <select
          id="absence-kind"
          name="kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'SICKNESS' | 'OTHER')}
        >
          <option value="SICKNESS">Krankheit</option>
          <option value="OTHER">Sonstige Abwesenheit (Fortbildung, Sonderurlaub …)</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="absence-startDate">
            Erster Tag
          </label>
          <input id="absence-startDate" name="startDate" type="date" className="input" required />
        </div>
        <div>
          <label className="label" htmlFor="absence-endDate">
            Letzter (optional)
          </label>
          <input id="absence-endDate" name="endDate" type="date" className="input" />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="absence-notes">
          Grund/Notizen (optional)
        </label>
        <textarea id="absence-notes" name="notes" rows={2} className="input" maxLength={1000} />
        <p className="text-[11px] text-disabled mt-1">
          Nur für Sie und Entscheidungsträger sichtbar — im Kalender erscheint nur „abw.".
        </p>
      </div>
      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && <div className="alert-success-sm">Eingetragen.</div>}
      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        {isPending
          ? 'Speichert…'
          : kind === 'SICKNESS'
            ? 'Krankmeldung speichern'
            : 'Abwesenheit melden'}
      </button>
    </form>
  );
}
