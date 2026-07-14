'use client';

import { useActionState, useRef, useEffect } from 'react';
import { createServiceProviderAction, type ActionResult } from './actions';

const categories = [
  'IT / Cloud',
  'Lohnbuchhaltung',
  'Steuersoftware',
  'Kommunikation',
  'Kanzleiverwaltung',
  'Reinigung',
  'Sonstiges',
];

export function NewProviderForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    createServiceProviderAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor="sp-name">
          Name
        </label>
        <input id="sp-name" name="name" type="text" className="input" required maxLength={200} />
      </div>

      <div>
        <label className="label" htmlFor="sp-category">
          Kategorie
        </label>
        <input
          id="sp-category"
          name="category"
          list="categories"
          className="input"
          required
          maxLength={100}
        />
        <datalist id="categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div>
        <label className="label" htmlFor="sp-contactEmail">
          Kontakt-E-Mail
        </label>
        <input
          id="sp-contactEmail"
          name="contactEmail"
          type="email"
          className="input"
          maxLength={255}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="sp-from">
            Vertrag seit
          </label>
          <input id="sp-from" name="contractFromDate" type="date" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="sp-to">
            bis
          </label>
          <input id="sp-to" name="contractToDate" type="date" className="input" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-secondary">
        <input type="checkbox" name="hasDataAccess" value="1" />
        Hat Zugriff auf personenbezogene Daten (DSGVO Art. 28)
      </label>

      <div>
        <label className="label" htmlFor="sp-notes">
          Notizen
        </label>
        <textarea id="sp-notes" name="notes" rows={3} className="input" maxLength={5000} />
      </div>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && <div className="alert-success-sm">Dienstleister angelegt.</div>}

      <button type="submit" className="btn-primary w-full" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Anlegen'}
      </button>
    </form>
  );
}
