'use client';

import { useActionState, useState } from 'react';
import { saveLegalEntityDetailsAction, type ActionResult } from './actions';
import type { EditableRepresentative } from './identity-subjects-context';
import { useGwgEditState } from './edit-state-context';

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
  currentRevision: string;
  disabled: boolean;
}

function editableLegalDetails(current: Props['current']) {
  return {
    legalForm: current.legalForm ?? '',
    registerNumber: current.registerNumber ?? '',
    registerAuthority: current.registerAuthority ?? '',
    noRegisterEntry: current.noRegisterEntry,
    ownershipStructureNotes: current.ownershipStructureNotes ?? '',
  };
}

export function LegalEntityDetailsForm({
  checkId,
  clientId,
  current,
  currentRevision,
  disabled,
}: Props) {
  const { markDraft, markRiskInvalidated } = useGwgEditState();
  const [details, setDetails] = useState(() => editableLegalDetails(current));
  const [savedRevision, setSavedRevision] = useState(currentRevision);
  const [state, action, pending] = useActionState<
    | (ActionResult & {
        reviewReset?: boolean;
        details?: {
          legalForm: string;
          registerNumber: string | null;
          registerAuthority: string | null;
          noRegisterEntry: boolean;
          representativeNames: string[];
          ownershipStructureNotes: string;
        };
        revision?: string;
      })
    | null,
    FormData
  >(async (previous, data) => {
    const result = await saveLegalEntityDetailsAction(previous, data);
    if (!result?.ok) return result;
    if (result.details) {
      setDetails({
        legalForm: result.details.legalForm,
        registerNumber: result.details.registerNumber ?? '',
        registerAuthority: result.details.registerAuthority ?? '',
        noRegisterEntry: result.details.noRegisterEntry,
        ownershipStructureNotes: result.details.ownershipStructureNotes,
      });
    }
    if (result.revision) setSavedRevision(result.revision);
    // Die Server-Action nullt die Risikofelder beim Speichern — das
    // Risiko-Formular muss seine CAS-Revision sofort nachziehen.
    markRiskInvalidated();
    if (result.reviewReset) markDraft();
    return result;
  }, null);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="expectedRevision" value={savedRevision} />
      <input
        type="hidden"
        name="representativesJson"
        value={JSON.stringify(
          current.representatives.map(({ id, fullName, linkedBeneficialOwnerId }) => ({
            id,
            fullName,
            isNew: false,
            linkedBeneficialOwnerId: linkedBeneficialOwnerId ?? null,
          })),
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
            value={details.legalForm}
            onChange={(event) =>
              setDetails((value) => ({ ...value, legalForm: event.target.value }))
            }
            disabled={disabled || pending}
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
            value={details.registerNumber}
            onChange={(event) =>
              setDetails((value) => ({ ...value, registerNumber: event.target.value }))
            }
            disabled={disabled || pending || details.noRegisterEntry}
            placeholder={
              details.noRegisterEntry ? 'entfällt (nicht registerpflichtig)' : 'z. B. HRB 12345'
            }
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
          value={details.registerAuthority}
          onChange={(event) =>
            setDetails((value) => ({ ...value, registerAuthority: event.target.value }))
          }
          disabled={disabled || pending || details.noRegisterEntry}
          placeholder={
            details.noRegisterEntry
              ? 'entfällt (nicht registerpflichtig)'
              : 'z. B. Handelsregister Amtsgericht München'
          }
        />
      </div>

      <label className="flex items-start gap-2 text-sm text-secondary">
        <input
          type="checkbox"
          name="noRegisterEntry"
          checked={details.noRegisterEntry}
          onChange={(event) =>
            setDetails((value) => ({ ...value, noRegisterEntry: event.target.checked }))
          }
          disabled={disabled || pending}
          className="mt-1"
        />
        <span>
          Nicht registerpflichtig / kein Registereintrag (z. B. einfache GbR). In diesem Fall sind
          Gesellschaftsvertrag bzw. Gründungsnachweis statt Register- und Transparenzregister-Auszug
          erforderlich.
        </span>
      </label>

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
          value={details.ownershipStructureNotes}
          onChange={(event) =>
            setDetails((value) => ({ ...value, ownershipStructureNotes: event.target.value }))
          }
          disabled={disabled || pending}
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
        <button type="submit" className="btn-primary text-sm" disabled={pending}>
          {pending ? 'Speichert…' : 'Rechtsträger-Angaben speichern'}
        </button>
      )}
    </form>
  );
}
