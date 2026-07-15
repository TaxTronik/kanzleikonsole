'use client';

import { useActionState, useEffect, useState } from 'react';
import { Plus, Trash2, UserRoundPlus } from 'lucide-react';
import {
  saveLegalEntityDetailsAction,
  type ActionResult,
  type InvalidatedIdentitySet,
} from './actions';
import { useGwgIdentitySubjects, type EditableRepresentative } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';

interface RepresentativeRow extends EditableRepresentative {
  isNew: boolean;
}

interface Props {
  checkId: string;
  clientId: string;
  current: {
    legalForm: string | null;
    registerNumber: string | null;
    registerAuthority: string | null;
    noRegisterEntry: boolean;
    representatives: EditableRepresentative[];
    ownershipStructureNotes: string | null;
  };
  knownPeople: Array<{ key: string; fullName: string; sourceLabel: string }>;
  currentRevision: string;
  disabled: boolean;
}

export function LegalEntityDetailsForm({
  checkId,
  clientId,
  current,
  knownPeople,
  currentRevision,
  disabled,
}: Props) {
  const { replaceRepresentatives, registerIdentityInvalidations } = useGwgIdentitySubjects();
  const { markDraft } = useGwgEditState();
  const [representatives, setRepresentatives] = useState<RepresentativeRow[]>(() =>
    current.representatives.map((representative) => ({ ...representative, isNew: false })),
  );
  const [knownPersonKey, setKnownPersonKey] = useState('');
  const [state, action, pending] = useActionState<
    | (ActionResult & {
        reviewReset?: boolean;
        representativesChanged?: boolean;
        representatives?: EditableRepresentative[];
        invalidatedIdentitySets?: InvalidatedIdentitySet[];
        revision?: string;
      })
    | null,
    FormData
  >(saveLegalEntityDetailsAction, null);

  useEffect(() => {
    if (!state?.ok || !state.representatives) return;
    setRepresentatives(
      state.representatives.map((representative) => ({ ...representative, isNew: false })),
    );
    replaceRepresentatives(state.representatives);
    registerIdentityInvalidations(state.invalidatedIdentitySets ?? []);
    if (state.reviewReset) markDraft();
  }, [markDraft, registerIdentityInvalidations, replaceRepresentatives, state]);

  function addRepresentative(fullName = '') {
    setRepresentatives((currentRows) => [
      ...currentRows,
      {
        id: crypto.randomUUID(),
        fullName,
        position: currentRows.length,
        isNew: true,
      },
    ]);
  }

  function removeRepresentative(id: string) {
    setRepresentatives((currentRows) =>
      currentRows
        .filter((representative) => representative.id !== id)
        .map((representative, position) => ({ ...representative, position })),
    );
  }

  function addKnownPerson() {
    const person = knownPeople.find((candidate) => candidate.key === knownPersonKey);
    if (!person) return;
    addRepresentative(person.fullName);
    setKnownPersonKey('');
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input
        type="hidden"
        name="expectedRevision"
        value={state?.ok && state.revision ? state.revision : currentRevision}
      />
      <input
        type="hidden"
        name="representativesJson"
        value={JSON.stringify(
          representatives.map(({ id, fullName, isNew }) => ({ id, fullName, isNew })),
        )}
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="gwg-legal-form">
            Rechtsform
          </label>
          <input
            id="gwg-legal-form"
            name="legalForm"
            className="input"
            required
            maxLength={100}
            defaultValue={current.legalForm ?? ''}
            disabled={disabled}
            placeholder="z. B. GmbH, eGbR, KG"
          />
        </div>
        <div>
          <label className="label" htmlFor="gwg-register-number">
            Registernummer
          </label>
          <input
            id="gwg-register-number"
            name="registerNumber"
            className="input"
            maxLength={100}
            defaultValue={current.registerNumber ?? ''}
            disabled={disabled}
            placeholder="z. B. HRB 12345"
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="gwg-register-authority">
          Register / Registergericht
        </label>
        <input
          id="gwg-register-authority"
          name="registerAuthority"
          className="input"
          maxLength={200}
          defaultValue={current.registerAuthority ?? ''}
          disabled={disabled}
          placeholder="z. B. Handelsregister Amtsgericht München"
        />
      </div>

      <label className="flex items-start gap-2 text-sm text-secondary">
        <input
          type="checkbox"
          name="noRegisterEntry"
          defaultChecked={current.noRegisterEntry}
          disabled={disabled}
          className="mt-1"
        />
        <span>
          Nicht registerpflichtig / kein Registereintrag (z. B. einfache GbR). In diesem Fall sind
          Gesellschaftsvertrag bzw. Gründungsnachweis statt Register- und Transparenzregister-Auszug
          erforderlich.
        </span>
      </label>

      <fieldset className="space-y-3" disabled={disabled || pending}>
        <legend className="label">Mitglieder des Vertretungsorgans / gesetzliche Vertreter</legend>
        <p className="text-xs text-muted">
          Jede Person wird als eigener Datensatz geführt und kann danach ihrem Ausweis eindeutig
          zugeordnet werden.
        </p>

        {knownPeople.length > 0 && (
          <div className="flex items-end gap-2 rounded-md border border-default bg-subtle p-3">
            <div className="min-w-0 flex-1">
              <label className="label-sm" htmlFor="gwg-known-representative">
                Bereits angelegte Person auswählen
              </label>
              <select
                id="gwg-known-representative"
                className="input"
                value={knownPersonKey}
                onChange={(event) => setKnownPersonKey(event.target.value)}
              >
                <option value="">— Person auswählen —</option>
                {knownPeople.map((person) => (
                  <option key={person.key} value={person.key}>
                    {person.fullName} · {person.sourceLabel}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={addKnownPerson}
              disabled={!knownPersonKey}
            >
              <UserRoundPlus className="h-3.5 w-3.5" /> Übernehmen
            </button>
          </div>
        )}

        <div className="space-y-2">
          {representatives.map((representative, index) => (
            <div key={representative.id} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-center text-xs text-muted">{index + 1}.</span>
              <label className="sr-only" htmlFor={`gwg-representative-${representative.id}`}>
                Name der vertretungsberechtigten Person {index + 1}
              </label>
              <input
                id={`gwg-representative-${representative.id}`}
                className="input"
                value={representative.fullName}
                onChange={(event) =>
                  setRepresentatives((currentRows) =>
                    currentRows.map((entry) =>
                      entry.id === representative.id
                        ? { ...entry, fullName: event.target.value }
                        : entry,
                    ),
                  )
                }
                required
                maxLength={200}
                placeholder="Vor- und Nachname"
              />
              <button
                type="button"
                className="btn-secondary px-2"
                onClick={() => removeRepresentative(representative.id)}
                disabled={representatives.length === 1}
                aria-label={`${representative.fullName || `Person ${index + 1}`} entfernen`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <button type="button" className="btn-secondary text-xs" onClick={() => addRepresentative()}>
          <Plus className="h-3.5 w-3.5" /> Neue Person anlegen
        </button>
        {representatives.length === 0 && (
          <p className="text-xs text-red-700">
            Mindestens eine vertretungsberechtigte Person ist erforderlich.
          </p>
        )}
      </fieldset>

      <div>
        <label className="label" htmlFor="gwg-ownership-structure">
          Eigentums- und Kontrollstruktur / Ermittlung des wirtschaftlich Berechtigten
        </label>
        <textarea
          id="gwg-ownership-structure"
          name="ownershipStructureNotes"
          className="input"
          rows={4}
          required
          maxLength={10000}
          defaultValue={current.ownershipStructureNotes ?? ''}
          disabled={disabled}
          placeholder="Register-/Transparenzregister-Abgleich, Beteiligungskette, fiktiv wirtschaftlich Berechtigter …"
        />
      </div>

      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && (
        <div className="alert-success-sm">
          Rechtsträger-Angaben gespeichert.
          {state.reviewReset
            ? ' Die laufende Prüfung wurde zur erneuten Freigabe zurückgesetzt.'
            : ''}
        </div>
      )}

      {!disabled && (
        <button
          type="submit"
          className="btn-primary text-sm"
          disabled={pending || representatives.length === 0}
        >
          {pending ? 'Speichert…' : 'Rechtsträger-Angaben speichern'}
        </button>
      )}
    </form>
  );
}
