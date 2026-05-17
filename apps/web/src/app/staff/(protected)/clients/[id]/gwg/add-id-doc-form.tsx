'use client';

import { useActionState, useRef, useEffect } from 'react';
import { addIdDocumentAction, type ActionResult } from './actions';

const types = [
  { value: 'PERSONALAUSWEIS', label: 'Personalausweis' },
  { value: 'REISEPASS', label: 'Reisepass' },
  { value: 'HANDELSREGISTERAUSZUG', label: 'Handelsregisterauszug' },
  { value: 'GESELLSCHAFTSVERTRAG', label: 'Gesellschaftsvertrag' },
  { value: 'VOLLMACHT', label: 'Vollmacht' },
  { value: 'TRANSPARENZREGISTER_AUSZUG', label: 'Transparenzregister-Auszug' },
  { value: 'SONSTIGES', label: 'Sonstiges' },
];

interface Props {
  checkId: string;
  clientId: string;
  clientDocuments: Array<{ id: string; title: string }>;
}

export function AddIdDocumentForm({ checkId, clientId, clientDocuments }: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    addIdDocumentAction,
    null,
  );

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3 p-4 border border-dashed border-gray-300 rounded-md">
      <p className="text-xs text-gray-500 uppercase tracking-wide">Identitätsdokument hinzufügen</p>
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="clientId" value={clientId} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="id-type">Typ</label>
          <select id="id-type" name="type" className="input" required defaultValue="PERSONALAUSWEIS">
            {types.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="id-ownerName">Inhaber</label>
          <input id="id-ownerName" name="ownerName" type="text" className="input" required maxLength={200} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label" htmlFor="id-number">Nummer</label>
          <input id="id-number" name="number" type="text" className="input" maxLength={100} />
        </div>
        <div>
          <label className="label" htmlFor="id-issueDate">Ausgestellt am</label>
          <input id="id-issueDate" name="issueDate" type="date" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="id-expiryDate">Gültig bis</label>
          <input id="id-expiryDate" name="expiryDate" type="date" className="input" />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="id-issuedBy">Ausstellende Behörde</label>
        <input id="id-issuedBy" name="issuedBy" type="text" className="input" maxLength={200} />
      </div>

      {clientDocuments.length > 0 && (
        <div>
          <label className="label" htmlFor="id-documentId">Verknüpftes hochgeladenes Dokument (optional)</label>
          <select id="id-documentId" name="documentId" className="input" defaultValue="">
            <option value="">— keines —</option>
            {clientDocuments.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        </div>
      )}

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}

      <button type="submit" className="btn-primary text-sm" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Hinzufügen'}
      </button>
    </form>
  );
}
