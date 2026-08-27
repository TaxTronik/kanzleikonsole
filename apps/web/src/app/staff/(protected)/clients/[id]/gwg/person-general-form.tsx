'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ContactRound, Pencil, X } from 'lucide-react';
import { updateGwgPersonGeneralAction, type SavedGwgPersonGeneral } from './owner-actions';
import type { ActionResult, InvalidatedIdentitySet } from './actions';
import { useGwgIdentitySubjects } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';

export function PersonGeneralForm({
  ownerId,
  representativeId,
  checkId,
  clientId,
  value,
  revision,
  disabled,
}: {
  ownerId: string | null;
  representativeId: string | null;
  checkId: string;
  clientId: string;
  value: SavedGwgPersonGeneral;
  revision: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const { registerIdentityInvalidations } = useGwgIdentitySubjects();
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [editing, setEditing] = useState(false);
  const [displayValue, setDisplayValue] = useState(value);
  const [draftValue, setDraftValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [state, action, pending] = useActionState<
    | (ActionResult & {
        saved?: SavedGwgPersonGeneral;
        revision?: string;
        reviewReset?: boolean;
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
      })
    | null,
    FormData
  >(updateGwgPersonGeneralAction, null);
  const fieldId = (field: string) => `person-general-${ownerId ?? representativeId}-${field}`;

  useEffect(() => {
    if (!state?.ok || !state.saved) return;
    setDisplayValue(state.saved);
    setDraftValue(state.saved);
    if (state.revision) setCurrentRevision(state.revision);
    registerIdentityInvalidations(state.invalidatedIdentitySets ?? []);
    if (state.reviewReset) markDraft();
    markRiskInvalidated();
    setEditing(false);
    router.refresh();
  }, [markDraft, markRiskInvalidated, registerIdentityInvalidations, router, state]);

  return (
    <details className="details-box">
      <summary>
        <ContactRound className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm font-semibold text-primary">
          Allgemeine Angaben
        </span>
        {displayValue.isPep === true && <span className="badge badge-red">PEP</span>}
      </summary>
      <div className="details-body space-y-4">
        {!editing ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-xs text-muted">Name</dt>
                <dd className="text-sm font-medium text-primary">{displayValue.fullName}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Geburtsdatum</dt>
                <dd className="text-sm text-primary">
                  {displayValue.birthDate || 'Nicht erfasst'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Geburtsort</dt>
                <dd className="text-sm text-primary">
                  {displayValue.birthPlace || 'Nicht erfasst'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Staatsangehörigkeit</dt>
                <dd className="text-sm text-primary">
                  {displayValue.nationality || 'Nicht erfasst'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Wohnsitz</dt>
                <dd className="text-sm text-primary">
                  {displayValue.residence || 'Nicht erfasst'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">PEP-Status</dt>
                <dd className="text-sm text-primary">
                  {displayValue.isPep === null
                    ? 'Nicht erfasst'
                    : displayValue.isPep
                      ? 'PEP / enges Familienmitglied'
                      : 'Keine PEP'}
                </dd>
              </div>
            </dl>
            {!disabled && (
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3.5 w-3.5" /> Bearbeiten
              </button>
            )}
          </>
        ) : (
          <form action={action} className="space-y-4">
            <input type="hidden" name="ownerId" value={ownerId ?? ''} />
            <input type="hidden" name="representativeId" value={representativeId ?? ''} />
            <input type="hidden" name="checkId" value={checkId} />
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="expectedRevision" value={currentRevision} />
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-muted">
                Änderungen gelten für die Person in allen zugeordneten Rollen.
              </p>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setDraftValue(displayValue);
                  setEditing(false);
                }}
                aria-label="Bearbeitung der allgemeinen Angaben schließen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label-sm" htmlFor={fieldId('full-name')}>
                  Name
                </label>
                <input
                  id={fieldId('full-name')}
                  name="fullName"
                  className="input"
                  value={draftValue.fullName}
                  onChange={(event) =>
                    setDraftValue((current) => ({ ...current, fullName: event.target.value }))
                  }
                  maxLength={200}
                  required
                  disabled={pending}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={fieldId('birth-date')}>
                  Geburtsdatum
                </label>
                <input
                  id={fieldId('birth-date')}
                  name="birthDate"
                  type="date"
                  className="input"
                  value={draftValue.birthDate}
                  onChange={(event) =>
                    setDraftValue((current) => ({ ...current, birthDate: event.target.value }))
                  }
                  required
                  disabled={pending}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={fieldId('birth-place')}>
                  Geburtsort
                </label>
                <input
                  id={fieldId('birth-place')}
                  name="birthPlace"
                  className="input"
                  value={draftValue.birthPlace}
                  onChange={(event) =>
                    setDraftValue((current) => ({ ...current, birthPlace: event.target.value }))
                  }
                  maxLength={200}
                  required
                  disabled={pending}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={fieldId('nationality')}>
                  Staatsangehörigkeit
                </label>
                <input
                  id={fieldId('nationality')}
                  name="nationality"
                  className="input"
                  value={draftValue.nationality}
                  onChange={(event) =>
                    setDraftValue((current) => ({ ...current, nationality: event.target.value }))
                  }
                  maxLength={100}
                  required
                  disabled={pending}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={fieldId('residence')}>
                  Wohnsitz
                </label>
                <input
                  id={fieldId('residence')}
                  name="residence"
                  className="input"
                  value={draftValue.residence}
                  onChange={(event) =>
                    setDraftValue((current) => ({ ...current, residence: event.target.value }))
                  }
                  maxLength={500}
                  required
                  disabled={pending}
                />
              </div>
              <div>
                <label className="label-sm" htmlFor={fieldId('pep')}>
                  PEP-Status
                </label>
                <select
                  id={fieldId('pep')}
                  name="isPep"
                  className="input"
                  value={draftValue.isPep === null ? '' : draftValue.isPep ? 'true' : 'false'}
                  onChange={(event) =>
                    setDraftValue((current) => ({
                      ...current,
                      isPep: event.target.value === 'true',
                    }))
                  }
                  required
                  disabled={pending}
                >
                  <option value="" disabled>
                    Bitte auswählen
                  </option>
                  <option value="false">Keine PEP</option>
                  <option value="true">PEP / enges Familienmitglied</option>
                </select>
              </div>
            </div>
            {state?.error && <div className="alert-error-sm">{state.error}</div>}
            <button type="submit" className="btn-primary text-xs" disabled={pending}>
              {pending ? 'Speichert…' : 'Allgemeine Angaben speichern'}
            </button>
          </form>
        )}
      </div>
    </details>
  );
}
