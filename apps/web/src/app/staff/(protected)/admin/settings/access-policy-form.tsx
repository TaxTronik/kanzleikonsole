'use client';

import { useActionState } from 'react';
import { saveAccessPolicyAction, type ActionResult } from './actions';
import type { AccessPolicy } from '@/server/settings/access-policy';

const MODES: Array<{ value: 'OPEN' | 'RESTRICTED'; label: string; description: string }> = [
  {
    value: 'OPEN',
    label: 'Offen (kanzleiweite Zusammenarbeit)',
    description:
      'Jeder aktive Mitarbeiter darf an jedem Mandanten arbeiten — auch ohne Zuordnung. Jeder Zugriff wird im Audit-Log protokolliert. Einzelne Mandanten lassen sich in den Stammdaten als „vertraulich" abschirmen (dann nur Admin/Partner + Zugeordnete).',
  },
  {
    value: 'RESTRICTED',
    label: 'Beschränkt (nur Zugeordnete)',
    description:
      'Nur Admin/Partner sowie die zugeordneten Berufsträger/Hauptbearbeiter sehen einen Mandanten. Strengere Abschottung — z. B. wenn die Mandate klar getrennt geführt werden.',
  },
];

export function AccessPolicyForm({ initial }: { initial: AccessPolicy }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveAccessPolicyAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="sr-only">Zugriffsmodell für Mandanten</legend>
        {MODES.map((m) => (
          <label
            key={m.value}
            className="flex items-start gap-3"
            htmlFor={`client-access-mode-${m.value}`}
            aria-label={m.label}
          >
            <input
              id={`client-access-mode-${m.value}`}
              type="radio"
              name="clientAccessMode"
              value={m.value}
              defaultChecked={initial.clientAccessMode === m.value}
              className="mt-1 text-brand-600"
            />
            <span>
              <span className="block text-sm font-medium text-primary">{m.label}</span>
              <span className="block text-xs text-muted">{m.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {state?.error && (
        <div className="alert-error-sm" role="alert">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="alert-success-sm" role="status">
          Zugriffsmodell gespeichert. Wirkt ab dem nächsten Seitenaufruf.
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Speichern'}
      </button>
    </form>
  );
}
