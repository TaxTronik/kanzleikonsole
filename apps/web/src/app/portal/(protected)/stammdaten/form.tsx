'use client';

import { useState, useTransition } from 'react';
import { submitMasterChangeAction } from './actions';

interface Stammdaten {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  vatId: string;
  invoiceEmail: string;
}

export function StammdatenForm({
  clientId,
  current,
  disabled,
}: {
  clientId: string;
  current: Stammdaten;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<Stammdaten>(current);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, start] = useTransition();

  function set<K extends keyof Stammdaten>(k: K, v: string) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function changedFields(): Partial<Stammdaten> {
    const out: Partial<Stammdaten> = {};
    (Object.keys(current) as Array<keyof Stammdaten>).forEach((k) => {
      const curr = (current[k] ?? '').trim();
      const next = (draft[k] ?? '').trim();
      if (curr !== next) out[k] = next;
    });
    return out;
  }

  function submit() {
    setError(null);
    setSuccess(false);
    const changes = changedFields();
    if (Object.keys(changes).length === 0) {
      setError('Keine Änderungen vorgenommen.');
      return;
    }
    start(async () => {
      const r = await submitMasterChangeAction({
        clientId,
        fields: changes,
        note: note.trim() || null,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Einreichen.');
        return;
      }
      setSuccess(true);
    });
  }

  const fieldDef: Array<[keyof Stammdaten, string, string?]> = [
    ['name', 'Name / Firma'],
    ['street', 'Straße'],
    ['postalCode', 'PLZ'],
    ['city', 'Ort'],
    ['countryIso', 'Land (ISO-2)'],
    ['vatId', 'USt-ID'],
    ['invoiceEmail', 'Rechnungs-Mail'],
  ];

  return (
    <div className="card p-6 space-y-4">
      {fieldDef.map(([k, label]) => {
        const isChanged =
          !disabled &&
          (current[k] ?? '').trim() !== (draft[k] ?? '').trim();
        return (
          <div key={k}>
            <label className="label" htmlFor={`f-${k}`}>{label}</label>
            <input
              id={`f-${k}`}
              type={k === 'invoiceEmail' ? 'email' : 'text'}
              value={draft[k]}
              onChange={(e) => set(k, e.target.value)}
              disabled={disabled || isPending}
              maxLength={k === 'countryIso' ? 2 : 255}
              className={
                'input' +
                (isChanged ? ' ring-2 ring-yellow-400 border-yellow-400' : '')
              }
            />
            {isChanged && (
              <p className="text-xs text-yellow-700 mt-1">
                Bisher: {current[k] || '—'}
              </p>
            )}
          </div>
        );
      })}

      <div>
        <label className="label" htmlFor="note">Nachricht an die Kanzlei (optional)</label>
        <textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          disabled={disabled || isPending}
          placeholder="z. B. Grund der Änderung"
          className="input text-sm"
        />
      </div>

      {error && <div className="alert-error-sm">{error}</div>}
      {success && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          Ihre Änderung wurde an die Kanzlei übermittelt. Sie erhalten eine
          Nachricht, sobald sie geprüft wurde.
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={disabled || isPending}
        className="btn-primary"
      >
        {isPending ? 'Sendet…' : 'Änderung einreichen'}
      </button>
      {disabled && (
        <p className="text-xs text-muted">
          Bestehende Anfrage wird gerade von Ihrer Kanzlei geprüft.
        </p>
      )}
    </div>
  );
}
