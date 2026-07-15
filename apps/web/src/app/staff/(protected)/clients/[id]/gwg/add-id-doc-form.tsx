'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { addIdDocumentAction, type ActionResult } from './actions';

const identityTypes = [
  { value: 'PERSONALAUSWEIS', label: 'Personalausweis' },
  { value: 'REISEPASS', label: 'Reisepass' },
] as const;

const entityTypes = [
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag / Gründungsnachweis' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'VOLLMACHT', label: 'Vertretungsvollmacht' },
  { value: 'SONSTIGES', label: 'Sonstiger Rechtsträgernachweis' },
] as const;

interface Props {
  checkId: string;
  clientId: string;
  clientName: string;
  clientDocuments: Array<{ id: string; title: string }>;
  variant: 'identity' | 'entity';
}

export function AddIdDocumentForm({
  checkId,
  clientId,
  clientName,
  clientDocuments,
  variant,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const types = variant === 'identity' ? identityTypes : entityTypes;
  const [type, setType] = useState<string>(types[0].value);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    addIdDocumentAction,
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    setType(types[0].value);
  }, [state, types]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="space-y-3 p-4 border border-dashed border-strong rounded-md"
    >
      <p className="text-xs text-muted uppercase tracking-wide">
        {variant === 'identity' ? 'Identitätsdokument zuordnen' : 'Rechtsträgernachweis zuordnen'}
      </p>
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />
      {variant === 'entity' && <input type="hidden" name="ownerName" value={clientName} />}

      <div className={variant === 'identity' ? 'grid grid-cols-2 gap-3' : ''}>
        <div>
          <label className="label" htmlFor={`${variant}-document-type`}>
            Typ
          </label>
          <select
            id={`${variant}-document-type`}
            name="type"
            className="input"
            required
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            {types.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {variant === 'identity' && (
          <div>
            <label className="label" htmlFor="id-ownerName">
              Identifizierte Person
            </label>
            <input
              id="id-ownerName"
              name="ownerName"
              type="text"
              className="input"
              required
              maxLength={200}
            />
          </div>
        )}
      </div>

      {variant === 'identity' && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="id-number">
                Ausweisnummer
              </label>
              <input
                id="id-number"
                name="number"
                type="text"
                className="input"
                required
                maxLength={100}
              />
            </div>
            <div>
              <label className="label" htmlFor="id-issueDate">
                Ausgestellt am
              </label>
              <input id="id-issueDate" name="issueDate" type="date" className="input" />
            </div>
            <div>
              <label className="label" htmlFor="id-expiryDate">
                Gültig bis
              </label>
              <input id="id-expiryDate" name="expiryDate" type="date" className="input" required />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="id-issuedBy">
              Ausstellende Behörde
            </label>
            <input
              id="id-issuedBy"
              name="issuedBy"
              type="text"
              className="input"
              required
              maxLength={200}
            />
          </div>
        </>
      )}

      <div>
        <label className="label" htmlFor={`${variant}-documentId`}>
          Hochgeladenes GwG-Dokument
        </label>
        {clientDocuments.length > 0 ? (
          <select
            id={`${variant}-documentId`}
            name="documentId"
            className="input"
            defaultValue=""
            required
          >
            <option value="" disabled>
              — Dokument auswählen —
            </option>
            {clientDocuments.map((document) => (
              <option key={document.id} value={document.id}>
                {document.title}
              </option>
            ))}
          </select>
        ) : (
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            Noch kein GwG-Nachweis vorhanden. Laden Sie zuerst über den Button oben eine Datei hoch.
          </p>
        )}
      </div>

      {variant === 'entity' && (
        <p className="text-xs text-muted">
          Personenbezogene Ausweisfelder sind für diesen Nachweistyp bewusst nicht erforderlich.
        </p>
      )}
      {state?.error && <div className="alert-error-sm">{state.error}</div>}
      {state?.ok && <div className="alert-success-sm">Nachweis wurde der Prüfung zugeordnet.</div>}

      <button
        type="submit"
        className="btn-primary text-sm"
        disabled={isPending || clientDocuments.length === 0}
      >
        {isPending ? 'Speichert…' : 'Nachweis zuordnen'}
      </button>
    </form>
  );
}
