'use client';

import { useActionState } from 'react';
import { saveLegalEntityDetailsAction, type ActionResult } from './actions';

interface Props {
  checkId: string;
  clientId: string;
  current: {
    legalForm: string | null;
    registerNumber: string | null;
    registerAuthority: string | null;
    noRegisterEntry: boolean;
    representativeNames: string[];
    ownershipStructureNotes: string | null;
  };
  disabled: boolean;
}

export function LegalEntityDetailsForm({ checkId, clientId, current, disabled }: Props) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    saveLegalEntityDetailsAction,
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />

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

      <div>
        <label className="label" htmlFor="gwg-representatives">
          Mitglieder des Vertretungsorgans / gesetzliche Vertreter
        </label>
        <textarea
          id="gwg-representatives"
          name="representativeNamesText"
          className="input"
          rows={3}
          required
          maxLength={4000}
          defaultValue={current.representativeNames.join('\n')}
          disabled={disabled}
          placeholder={'Eine Person pro Zeile\nErika Musterfrau'}
        />
        <p className="text-xs text-muted mt-1">
          Mindestens eine hier genannte Person muss über Personalausweis/Reisepass identifiziert
          sein.
        </p>
      </div>

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
      {state?.ok && <div className="text-sm text-green-700">Rechtsträger-Angaben gespeichert.</div>}

      {!disabled && (
        <button type="submit" className="btn-primary text-sm" disabled={pending}>
          {pending ? 'Speichert…' : 'Rechtsträger-Angaben speichern'}
        </button>
      )}
    </form>
  );
}
