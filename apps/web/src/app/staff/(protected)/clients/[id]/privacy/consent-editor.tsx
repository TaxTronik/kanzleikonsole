'use client';

import { useActionState } from 'react';
import type { ActionResult } from '@/server/actions/types';
import { ConsentFields } from '@/components/consent-fields';
import type { ConsentSelections, ResolvedConsentOption } from '@/server/privacy/consent';
import { saveConsentAction } from './actions';

export function ConsentEditor({
  clientId,
  initial,
  contacts,
  options,
}: {
  clientId: string;
  initial?: ConsentSelections;
  contacts: Array<{ id: string; fullName: string }>;
  options: ResolvedConsentOption[];
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveConsentAction,
    null,
  );

  return (
    <form action={formAction} className="card p-6 space-y-6">
      <input type="hidden" name="clientId" value={clientId} />

      <ConsentFields initial={initial} options={options} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-default pt-4">
        <div>
          <label className="label-sm" htmlFor="client-consent-signed-by-name">
            Unterschrift / Name der erklärenden Person *
          </label>
          <input
            id="client-consent-signed-by-name"
            name="signedByName"
            required
            maxLength={300}
            className="input w-full"
            placeholder="z. B. Erika Mustermann (Geschäftsführerin)"
          />
        </div>
        <div>
          <label className="label-sm" htmlFor="client-consent-signed-by-contact">
            Zugeordnete Kontaktperson (optional)
          </label>
          <select
            id="client-consent-signed-by-contact"
            name="signedByContact"
            className="input w-full"
            defaultValue=""
          >
            <option value="">— keine —</option>
            {contacts.map((k) => (
              <option key={k.id} value={k.id}>
                {k.fullName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label-sm" htmlFor="client-consent-note">
          Notiz (optional)
        </label>
        <input
          id="client-consent-note"
          name="note"
          maxLength={2000}
          className="input w-full"
          placeholder="z. B. bei Mandatsannahme unterschrieben, Papierformular in Akte"
        />
      </div>

      {state && !state.ok && state.error && (
        <div
          className="rounded-md bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div
          className="rounded-md bg-green-50 dark:bg-green-950/40 p-3 text-sm text-green-700 dark:text-green-300"
          role="status"
        >
          Einwilligungsstand gespeichert (neuer Nachweis-Snapshot angelegt).
        </div>
      )}

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichert…' : 'Einwilligungsstand speichern'}
        </button>
      </div>
    </form>
  );
}
