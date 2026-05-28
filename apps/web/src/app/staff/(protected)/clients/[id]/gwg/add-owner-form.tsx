'use client';

import { useActionState, useRef, useEffect } from 'react';
import { addBeneficialOwnerAction, type ActionResult } from './actions';

export function AddBeneficialOwnerForm({
  checkId,
  clientId,
}: {
  checkId: string;
  clientId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    addBeneficialOwnerAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3 p-4 border border-dashed border-strong rounded-md">
      <p className="text-xs text-muted uppercase tracking-wide">Person hinzufügen</p>
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bo-fullName">Name</label>
          <input id="bo-fullName" name="fullName" type="text" className="input" required maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="bo-birthDate">Geburtsdatum</label>
          <input id="bo-birthDate" name="birthDate" type="date" className="input" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bo-birthPlace">Geburtsort</label>
          <input id="bo-birthPlace" name="birthPlace" type="text" className="input" maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="bo-nationality">Staatsangehörigkeit</label>
          <input id="bo-nationality" name="nationality" type="text" className="input" maxLength={100} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bo-residence">Wohnsitz</label>
          <input id="bo-residence" name="residence" type="text" className="input" maxLength={500} />
        </div>
        <div>
          <label className="label" htmlFor="bo-ownershipPct">Anteil (%)</label>
          <input
            id="bo-ownershipPct"
            name="ownershipPct"
            type="number"
            step="0.01"
            min="0"
            max="100"
            className="input"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-secondary">
        <input type="checkbox" name="isPep" value="1" />
        Politisch exponierte Person (PEP)
      </label>

      {state?.error && (
        <div className="alert-error-sm">{state.error}</div>
      )}

      <button type="submit" className="btn-primary text-sm" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Person hinzufügen'}
      </button>
    </form>
  );
}
