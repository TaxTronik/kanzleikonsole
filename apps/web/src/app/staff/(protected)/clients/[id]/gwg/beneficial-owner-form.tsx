'use client';

import { useActionState } from 'react';
import { updateBeneficialOwnerAction, type ActionResult } from './actions';

type BeneficialOwnerFormValue = {
  fullName: string;
  birthDate: string;
  birthPlace: string;
  residence: string;
  nationality: string;
  ownershipPct: string;
  isPep: boolean;
};

export function BeneficialOwnerForm({
  ownerId,
  checkId,
  clientId,
  value,
  revision,
}: {
  ownerId: string;
  checkId: string;
  clientId: string;
  value: BeneficialOwnerFormValue;
  revision: string;
}) {
  const [state, action, pending] = useActionState<
    (ActionResult & { revision?: string }) | null,
    FormData
  >(updateBeneficialOwnerAction, null);
  const id = (field: string) => `owner-${ownerId}-${field}`;

  return (
    <details className="mt-3 rounded-md border border-default bg-subtle px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-secondary">
        Angaben bearbeiten
      </summary>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="ownerId" value={ownerId} />
        <input type="hidden" name="checkId" value={checkId} />
        <input type="hidden" name="clientId" value={clientId} />
        <input
          type="hidden"
          name="expectedRevision"
          value={state?.ok && state.revision ? state.revision : revision}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label-sm" htmlFor={id('fullName')}>
              Name
            </label>
            <input
              id={id('fullName')}
              name="fullName"
              type="text"
              className="input"
              defaultValue={value.fullName}
              maxLength={200}
              required
              disabled={pending}
            />
          </div>
          <div>
            <label className="label-sm" htmlFor={id('birthDate')}>
              Geburtsdatum
            </label>
            <input
              id={id('birthDate')}
              name="birthDate"
              type="date"
              className="input"
              defaultValue={value.birthDate}
              required
              disabled={pending}
            />
          </div>
          <div>
            <label className="label-sm" htmlFor={id('birthPlace')}>
              Geburtsort
            </label>
            <input
              id={id('birthPlace')}
              name="birthPlace"
              type="text"
              className="input"
              defaultValue={value.birthPlace}
              maxLength={200}
              required
              disabled={pending}
            />
          </div>
          <div>
            <label className="label-sm" htmlFor={id('nationality')}>
              Staatsangehörigkeit
            </label>
            <input
              id={id('nationality')}
              name="nationality"
              type="text"
              className="input"
              defaultValue={value.nationality}
              maxLength={100}
              required
              disabled={pending}
            />
          </div>
          <div>
            <label className="label-sm" htmlFor={id('residence')}>
              Wohnsitz
            </label>
            <input
              id={id('residence')}
              name="residence"
              type="text"
              className="input"
              defaultValue={value.residence}
              maxLength={500}
              required
              disabled={pending}
            />
          </div>
          <div>
            <label className="label-sm" htmlFor={id('ownershipPct')}>
              Anteil (%)
            </label>
            <input
              id={id('ownershipPct')}
              name="ownershipPct"
              type="number"
              className="input"
              defaultValue={value.ownershipPct}
              step="0.01"
              min="0"
              max="100"
              disabled={pending}
            />
          </div>
          <div>
            <label className="label-sm" htmlFor={id('isPep')}>
              PEP-Status
            </label>
            <select
              id={id('isPep')}
              name="isPep"
              className="input"
              defaultValue={value.isPep ? 'true' : 'false'}
              required
              disabled={pending}
            >
              <option value="false">Keine PEP</option>
              <option value="true">PEP / enges Familienmitglied</option>
            </select>
          </div>
        </div>

        <p className="text-xs text-muted">
          Eine Änderung setzt eine bereits eingereichte Prüfung wieder auf Entwurf zurück.
        </p>
        {state?.error && <div className="alert-error-sm">{state.error}</div>}
        {state?.ok && <p className="text-xs text-emerald-700">Gespeichert.</p>}
        <button type="submit" className="btn-secondary text-xs" disabled={pending}>
          {pending ? 'Speichert…' : 'Angaben speichern'}
        </button>
      </form>
    </details>
  );
}
