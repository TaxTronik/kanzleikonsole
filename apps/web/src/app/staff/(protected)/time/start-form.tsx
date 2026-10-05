'use client';

import { useActionState } from 'react';
import { Play } from 'lucide-react';
import { ClientCombobox } from '@/components/ui/client-combobox';
import { startTimerAction, type ActionResult } from './actions';

export function StartTimerForm() {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    startTimerAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="description">
          Was wird gemacht?
        </label>
        <input
          id="description"
          name="description"
          type="text"
          className="input"
          required
          minLength={1}
          maxLength={500}
          placeholder="z. B. Buchhaltung Q3"
          autoFocus
        />
      </div>

      <div>
        <label className="label" htmlFor="clientId">
          Mandant (optional)
        </label>
        {/* Leer = interne Zeit; Serversuche statt der ersten 500 Mandanten. */}
        <ClientCombobox id="clientId" name="clientId" placeholder="Intern — Mandant suchen" />
      </div>

      <label className="flex items-center gap-2 text-sm text-secondary">
        <input type="checkbox" name="billable" value="1" defaultChecked />
        Abrechenbar
      </label>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}

      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        <Play className="h-3.5 w-3.5" />
        {isPending ? 'Startet…' : 'Timer starten'}
      </button>
    </form>
  );
}
