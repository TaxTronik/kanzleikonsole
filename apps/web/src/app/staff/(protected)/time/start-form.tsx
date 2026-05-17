'use client';

import { useActionState } from 'react';
import { Play } from 'lucide-react';
import { startTimerAction, type ActionResult } from './actions';

interface Props {
  clients: Array<{ id: string; name: string }>;
}

export function StartTimerForm({ clients }: Props) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    startTimerAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="description">Was wird gemacht?</label>
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
        <label className="label" htmlFor="clientId">Mandant (optional)</label>
        <select id="clientId" name="clientId" className="input" defaultValue="">
          <option value="">— intern —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" name="billable" value="1" defaultChecked />
        Abrechenbar
      </label>

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}

      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        <Play className="h-3.5 w-3.5" />
        {isPending ? 'Startet…' : 'Timer starten'}
      </button>
    </form>
  );
}
