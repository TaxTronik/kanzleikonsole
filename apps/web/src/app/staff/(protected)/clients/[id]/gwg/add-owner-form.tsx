'use client';

import { useActionState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { addBeneficialOwnerAction, type ActionResult } from './actions';
import { useGwgEditState } from './edit-state-context';

export function AddBeneficialOwnerForm({
  checkId,
  clientId,
}: {
  checkId: string;
  clientId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const { markRiskInvalidated } = useGwgEditState();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    addBeneficialOwnerAction,
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    // Die Server-Action setzt die Risikobewertung zurück (invalidateRisk) —
    // das Risiko-Formular muss seine CAS-Revision sofort nachziehen.
    markRiskInvalidated();
    // Refresh AUSSERHALB der Form-Transition: die Action revalidiert die
    // aktuelle Route bewusst nicht mehr (hängende Transition bis zum
    // nächsten Klick) — die neue Person kommt über diesen Refresh herein.
    router.refresh();
  }, [markRiskInvalidated, router, state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="space-y-3 p-4 border border-dashed border-strong rounded-md"
    >
      <p className="text-xs text-muted uppercase tracking-wide">Person hinzufügen</p>
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bo-fullName">
            Name
          </label>
          <input
            id="bo-fullName"
            name="fullName"
            type="text"
            className="input"
            required
            maxLength={200}
          />
        </div>
        <div>
          <label className="label" htmlFor="bo-birthDate">
            Geburtsdatum
          </label>
          <input id="bo-birthDate" name="birthDate" type="date" className="input" required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bo-birthPlace">
            Geburtsort
          </label>
          <input
            id="bo-birthPlace"
            name="birthPlace"
            type="text"
            className="input"
            maxLength={200}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="bo-nationality">
            Staatsangehörigkeit
          </label>
          <input
            id="bo-nationality"
            name="nationality"
            type="text"
            className="input"
            maxLength={100}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="bo-residence">
            Wohnsitz
          </label>
          <input
            id="bo-residence"
            name="residence"
            type="text"
            className="input"
            maxLength={500}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="bo-ownershipPct">
            Anteil (%)
          </label>
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

      <div>
        <label className="label" htmlFor="bo-isPep">
          PEP-Status
        </label>
        <select id="bo-isPep" name="isPep" className="input" defaultValue="" required>
          <option value="" disabled>
            Bitte auswählen
          </option>
          <option value="false">Keine PEP</option>
          <option value="true">PEP / enges Familienmitglied</option>
        </select>
      </div>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}

      <button type="submit" className="btn-primary text-sm" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Person hinzufügen'}
      </button>
    </form>
  );
}
