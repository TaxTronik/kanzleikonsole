'use client';

import { useActionState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createFormTemplateAction, type ActionResult } from './actions';

export function CreateFormForm() {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createFormTemplateAction,
    null,
  );

  useEffect(() => {
    if (state?.ok && state.id) {
      ref.current?.reset();
      router.push(`/staff/forms/${state.id}`);
    }
  }, [state, router]);

  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="form-name">Name</label>
        <input id="form-name" name="name" type="text" className="input" required minLength={2} maxLength={100} placeholder="Steuerunterlagen 2025" />
      </div>
      <div>
        <label className="label" htmlFor="form-description">Beschreibung</label>
        <textarea id="form-description" name="description" rows={2} maxLength={500} className="input" />
      </div>
      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Vorlage anlegen'}
      </button>
    </form>
  );
}
