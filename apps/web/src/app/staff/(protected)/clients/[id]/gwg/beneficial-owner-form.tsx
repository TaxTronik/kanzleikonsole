'use client';

import { useActionState, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  removeBeneficialOwnerAction,
  updateBeneficialOwnerAction,
  type ActionResult,
  type InvalidatedIdentitySet,
  type SavedBeneficialOwner,
} from './actions';
import { useGwgIdentitySubjects } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';

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
  const { updateBeneficialOwner, removeBeneficialOwner, registerIdentityInvalidations } =
    useGwgIdentitySubjects();
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [displayValue, setDisplayValue] = useState(value);
  const [draftValue, setDraftValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [state, action, pending] = useActionState<
    | (ActionResult & {
        reviewReset?: boolean;
        revision?: string;
        saved?: SavedBeneficialOwner;
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
      })
    | null,
    FormData
  >(updateBeneficialOwnerAction, null);
  const [removeState, removeAction, removePending] = useActionState<
    | (ActionResult & {
        removedOwnerId?: string;
        reviewReset?: boolean;
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
      })
    | null,
    FormData
  >(removeBeneficialOwnerAction, null);
  const id = (field: string) => `owner-${ownerId}-${field}`;

  useEffect(() => {
    if (!state?.ok || !state.saved) return;
    updateBeneficialOwner(state.saved);
    setDisplayValue(state.saved);
    setDraftValue(state.saved);
    if (state.revision) setCurrentRevision(state.revision);
    registerIdentityInvalidations(state.invalidatedIdentitySets ?? []);
    // Die Server-Action setzt die Risikobewertung zurück (invalidateRisk) —
    // das Risiko-Formular muss seine CAS-Revision sofort nachziehen.
    markRiskInvalidated();
    if (state.reviewReset) markDraft();
  }, [markDraft, markRiskInvalidated, registerIdentityInvalidations, state, updateBeneficialOwner]);

  useEffect(() => {
    if (!removeState?.ok || !removeState.removedOwnerId) return;
    removeBeneficialOwner(removeState.removedOwnerId);
    registerIdentityInvalidations(removeState.invalidatedIdentitySets ?? []);
    markRiskInvalidated();
    if (removeState.reviewReset) markDraft();
  }, [
    markDraft,
    markRiskInvalidated,
    registerIdentityInvalidations,
    removeBeneficialOwner,
    removeState,
  ]);

  if (removeState?.ok && removeState.removedOwnerId === ownerId) {
    return (
      <div className="alert-success-sm w-full">
        Die Person wurde aus dem aktuellen Prüfsnapshot entfernt. Frühere Prüfungen bleiben
        unverändert erhalten.
      </div>
    );
  }

  return (
    <div className="min-w-0 w-full">
      <div className="flex items-center gap-2">
        <span className="font-medium text-primary">{displayValue.fullName}</span>
        {displayValue.isPep && <span className="badge-red">PEP</span>}
      </div>
      <p className="text-xs text-muted">
        {displayValue.ownershipPct ? `${Number(displayValue.ownershipPct).toFixed(2)} % · ` : ''}
        {displayValue.nationality}
        {displayValue.residence ? ` · ${displayValue.residence}` : ''}
      </p>
      <details className="mt-3 rounded-md border border-default bg-subtle px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-secondary">
          Angaben bearbeiten
        </summary>
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="expectedRevision" value={currentRevision} />

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
                value={draftValue.fullName}
                onChange={(event) =>
                  setDraftValue((current) => ({ ...current, fullName: event.target.value }))
                }
                maxLength={200}
                required
                disabled={pending || removePending}
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
                value={draftValue.birthDate}
                onChange={(event) =>
                  setDraftValue((current) => ({ ...current, birthDate: event.target.value }))
                }
                required
                disabled={pending || removePending}
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
                value={draftValue.birthPlace}
                onChange={(event) =>
                  setDraftValue((current) => ({ ...current, birthPlace: event.target.value }))
                }
                maxLength={200}
                required
                disabled={pending || removePending}
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
                value={draftValue.nationality}
                onChange={(event) =>
                  setDraftValue((current) => ({ ...current, nationality: event.target.value }))
                }
                maxLength={100}
                required
                disabled={pending || removePending}
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
                value={draftValue.residence}
                onChange={(event) =>
                  setDraftValue((current) => ({ ...current, residence: event.target.value }))
                }
                maxLength={500}
                required
                disabled={pending || removePending}
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
                value={draftValue.ownershipPct}
                onChange={(event) =>
                  setDraftValue((current) => ({ ...current, ownershipPct: event.target.value }))
                }
                step="0.01"
                min="0"
                max="100"
                disabled={pending || removePending}
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
                value={draftValue.isPep ? 'true' : 'false'}
                onChange={(event) =>
                  setDraftValue((current) => ({
                    ...current,
                    isPep: event.target.value === 'true',
                  }))
                }
                required
                disabled={pending || removePending}
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
          {state?.ok && (
            <p className="text-xs text-emerald-700">
              Gespeichert.
              {state.reviewReset
                ? ' Die laufende Prüfung wurde zur erneuten Freigabe zurückgesetzt.'
                : ''}
            </p>
          )}
          <button type="submit" className="btn-secondary text-xs" disabled={pending}>
            {pending ? 'Speichert…' : 'Angaben speichern'}
          </button>
        </form>
        <form
          action={removeAction}
          className="mt-3 border-t border-default pt-3"
          onSubmit={(event) => {
            if (
              !window.confirm(
                `${displayValue.fullName} wirklich aus dem aktuellen Prüfsnapshot entfernen? Zugeordnete Ausweise müssen danach neu zugeordnet werden.`,
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="checkId" value={checkId} />
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="expectedRevision" value={currentRevision} />
          {removeState?.error && <div className="alert-error-sm mb-2">{removeState.error}</div>}
          <button
            type="submit"
            className="btn-secondary text-xs text-red-700"
            disabled={removePending || pending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {removePending ? 'Entfernt…' : 'Nicht mehr wirtschaftlich berechtigt'}
          </button>
        </form>
      </details>
    </div>
  );
}
