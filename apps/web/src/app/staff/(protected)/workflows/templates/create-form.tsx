'use client';

import { useActionState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createTemplateAction, type ActionResult } from '../actions';

export function CreateTemplateForm() {
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createTemplateAction,
    null,
  );

  useEffect(() => {
    if (state?.ok && state.id) {
      ref.current?.reset();
      router.push(`/staff/workflows/templates/${state.id}`);
    }
  }, [state, router]);

  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="tpl-name">Name</label>
        <input id="tpl-name" name="name" type="text" className="input" required minLength={2} maxLength={100} placeholder="Neuer Mandant" />
      </div>
      <div>
        <label className="label" htmlFor="tpl-description">Beschreibung</label>
        <textarea id="tpl-description" name="description" rows={2} maxLength={500} className="input" />
      </div>
      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}
      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Vorlage anlegen'}
      </button>
    </form>
  );
}
