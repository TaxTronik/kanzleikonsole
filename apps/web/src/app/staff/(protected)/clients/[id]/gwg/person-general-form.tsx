'use client';

import { useActionState, useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { ContactRound, Pencil, X } from 'lucide-react';
import {
  IDENTITY_FIELD_LABELS,
  type IdentityField,
  type IdentitySuggestions,
} from '@/lib/gwg/identity-ocr';
import {
  updateGwgPersonGeneralAction,
  type GwgPersonGeneralActionResult,
  type SavedGwgPersonGeneral,
} from './owner-actions';
import { useGwgIdentitySubjects } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';
import {
  gwgPersonGeneralStateReducer,
  initialGwgPersonGeneralState,
} from './person-general-conflict';

function personSuggestionKey(
  ownerId: string | null,
  representativeId: string | null,
  clientId: string,
): string {
  if (representativeId) return `representative:${representativeId}`;
  return ownerId ? `owner:${ownerId}` : `client:${clientId}`;
}

function PersonSuggestions({
  suggestions,
  pending,
  onApply,
  onDiscard,
}: {
  suggestions: IdentitySuggestions | undefined;
  pending: boolean;
  onApply: (patch: Partial<SavedGwgPersonGeneral>) => void;
  onDiscard: () => void;
}) {
  if (!suggestions) return null;
  const entries = Object.entries(suggestions).filter(([key]) => !key.startsWith('id'));
  if (!entries.length) return null;
  const completeAddress = Boolean(suggestions.street && suggestions.postalCode && suggestions.city);
  const hasAddress = Boolean(suggestions.street || suggestions.postalCode || suggestions.city);
  return (
    <div className="rounded border border-blue-200 p-3 space-y-2">
      <p className="text-xs font-medium">
        Aus der Ausweishilfe ausgewählte Personenangaben (noch nicht gespeichert):
      </p>
      {entries.map(([key, value]) => (
        <p className="text-xs" key={key}>
          {IDENTITY_FIELD_LABELS[key as IdentityField]}: {value}
        </p>
      ))}
      <button
        type="button"
        className="btn-secondary text-xs"
        disabled={pending}
        onClick={() => {
          const patch: Partial<SavedGwgPersonGeneral> = {};
          for (const key of ['fullName', 'birthDate', 'birthPlace', 'nationality'] as const) {
            if (suggestions[key] !== undefined) patch[key] = suggestions[key];
          }
          if (completeAddress)
            patch.residence = `${suggestions.street}, ${suggestions.postalCode} ${suggestions.city}`;
          onApply(patch);
        }}
      >
        In allgemeine Angaben übernehmen und prüfen
      </button>
      {hasAddress && !completeAddress && (
        <p className="text-xs text-amber-700">
          Die Anschrift ist unvollständig. Bitte die angezeigten Angaben manuell in den vorhandenen
          Wohnsitz einarbeiten; dieser wird nicht ersetzt.
        </p>
      )}
      <button type="button" className="btn-secondary text-xs" onClick={onDiscard}>
        Verwerfen
      </button>
    </div>
  );
}

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
  const { registerIdentityInvalidations, personSuggestions, clearPersonSuggestions } =
    useGwgIdentitySubjects();
  const suggestionKey = personSuggestionKey(ownerId, representativeId, clientId);
  const suggestions = personSuggestions[suggestionKey];
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [local, dispatchLocal] = useReducer(
    gwgPersonGeneralStateReducer,
    initialGwgPersonGeneralState(value, revision),
  );
  const { editing, displayValue, draftValue, conflictNotice } = local;
  const [state, action, pending] = useActionState<GwgPersonGeneralActionResult | null, FormData>(
    updateGwgPersonGeneralAction,
    null,
  );
  const fieldId = (field: string) => `person-general-${ownerId ?? representativeId}-${field}`;

  useEffect(() => {
    if (!state?.ok || !state.saved) return;
    dispatchLocal({ type: 'save-succeeded', saved: state.saved, revision: state.revision });
    registerIdentityInvalidations(state.invalidatedIdentitySets ?? []);
    if (state.reviewReset) markDraft();
    markRiskInvalidated();
    router.refresh();
  }, [markDraft, markRiskInvalidated, registerIdentityInvalidations, router, state]);

  useEffect(() => {
    if (!state?.conflict || !state.latest || !state.revision) return;
    dispatchLocal({ type: 'conflict', latest: state.latest, revision: state.revision });
    router.refresh();
  }, [router, state]);

  // Ein RSC-Refresh darf einen offenen Entwurf nicht überschreiben. Außerhalb
  // des Bearbeitungsmodus wird ein neuer Serverstand hingegen sofort lokal
  // übernommen, sodass gar keine veraltete Revision abgesendet wird.
  useEffect(() => {
    dispatchLocal({ type: 'server-state', value, revision });
  }, [revision, value]);

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
        {!disabled && (
          <PersonSuggestions
            suggestions={suggestions}
            pending={pending}
            onApply={(patch) => {
              if (!editing) dispatchLocal({ type: 'start-editing' });
              dispatchLocal({ type: 'patch-draft', patch });
              clearPersonSuggestions(suggestionKey);
            }}
            onDiscard={() => clearPersonSuggestions(suggestionKey)}
          />
        )}
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
                onClick={() => dispatchLocal({ type: 'start-editing' })}
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
            <input type="hidden" name="expectedRevision" value={local.revision} />
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-muted">
                Änderungen gelten für die Person in allen zugeordneten Rollen.
              </p>
              <button
                type="button"
                className="modal-close"
                onClick={() => dispatchLocal({ type: 'cancel-editing' })}
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
                    dispatchLocal({
                      type: 'patch-draft',
                      patch: { fullName: event.target.value },
                    })
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
                    dispatchLocal({
                      type: 'patch-draft',
                      patch: { birthDate: event.target.value },
                    })
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
                    dispatchLocal({
                      type: 'patch-draft',
                      patch: { birthPlace: event.target.value },
                    })
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
                    dispatchLocal({
                      type: 'patch-draft',
                      patch: { nationality: event.target.value },
                    })
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
                    dispatchLocal({
                      type: 'patch-draft',
                      patch: { residence: event.target.value },
                    })
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
                    dispatchLocal({
                      type: 'patch-draft',
                      patch: { isPep: event.target.value === 'true' },
                    })
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
            {conflictNotice && (
              <div className="alert-info-sm flex items-start justify-between gap-3" role="status">
                <span>{conflictNotice}</span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-current opacity-70 transition hover:opacity-100"
                  onClick={() => dispatchLocal({ type: 'dismiss-conflict' })}
                  aria-label="Hinweis zum automatischen Abgleich schließen"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}
            {state?.error && !state.conflict && <div className="alert-error-sm">{state.error}</div>}
            <button type="submit" className="btn-primary text-xs" disabled={pending}>
              {pending ? 'Speichert…' : 'Allgemeine Angaben speichern'}
            </button>
          </form>
        )}
      </div>
    </details>
  );
}
