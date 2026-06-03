'use client';

import { useActionState, useRef, useEffect } from 'react';
import { createSkillAction } from './actions';
import type { ActionResult } from '@/server/actions/staff-action';

const COLOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '— Keine —' },
  { value: 'blue', label: 'Blau' },
  { value: 'amber', label: 'Bernstein' },
  { value: 'emerald', label: 'Grün' },
  { value: 'purple', label: 'Lila' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Rot' },
  { value: 'yellow', label: 'Gelb' },
  { value: 'gray', label: 'Grau' },
];

export function CreateSkillForm() {
  const ref = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createSkillAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label" htmlFor="skill-slug">Kürzel</label>
          <input
            id="skill-slug"
            name="slug"
            type="text"
            className="input font-mono"
            required
            minLength={2}
            maxLength={40}
            pattern="[A-Z0-9_]+"
            placeholder="USTA"
            title="Großbuchstaben/Ziffern/Unterstrich"
          />
        </div>
        <div className="col-span-2">
          <label className="label" htmlFor="skill-label">Anzeige-Name</label>
          <input
            id="skill-label"
            name="label"
            type="text"
            className="input"
            required
            minLength={2}
            maxLength={100}
            placeholder="USt-Voranmeldung"
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="skill-color">Farbe</label>
        <select id="skill-color" name="color" className="input">
          {COLOR_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {state?.error && (
        <div className="alert-error-sm">{state.error}</div>
      )}
      {state?.ok && (
        <div className="alert-success-sm">Tätigkeitsbereich angelegt.</div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Anlegen'}
      </button>
    </form>
  );
}
