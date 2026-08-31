'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TAX_STATES, normalizeTaxNumber, type TaxMasterDraft } from '@/lib/tax-registration';

export interface TaxMasterSaveInput {
  clientId: string;
  expectedRevision: string;
  draft: TaxMasterDraft;
  note?: string;
}

export function TaxMasterDataForm({
  clientId,
  initial,
  revision,
  action,
  portal = false,
  disabled = false,
}: {
  clientId: string;
  initial: TaxMasterDraft;
  revision: string;
  portal?: boolean;
  disabled?: boolean;
  action: (input: TaxMasterSaveInput) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [draft, setDraft] = useState(initial);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const blocked = disabled || pending || (portal && message?.ok === true);
  const prefix = portal ? 'portal-tax' : 'staff-tax';
  function updateRow(index: number, patch: Partial<TaxMasterDraft['registrations'][number]>) {
    setDraft((value) => ({
      ...value,
      registrations: value.registrations.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));
  }
  function submit() {
    setMessage(null);
    start(async () => {
      const result = await action({ clientId, expectedRevision: revision, draft, note });
      setMessage({
        ok: result.ok,
        text: result.ok
          ? portal
            ? 'Änderung zur Prüfung eingereicht.'
            : 'Steuerliche Stammdaten gespeichert.'
          : (result.error ?? 'Speichern fehlgeschlagen.'),
      });
      if (result.ok) router.refresh();
    });
  }
  return (
    <section className="card p-6 my-6 space-y-4" aria-labelledby={`${prefix}-title`}>
      <h2 id={`${prefix}-title`} className="text-lg font-semibold text-primary">
        Steuerliche Stammdaten
      </h2>
      <p className="text-sm text-muted">
        USt-ID und Steuerverbindungen lösen allein keine neue GwG-Prüfung aus.{' '}
        {portal
          ? 'Änderungen werden erst nach Prüfung durch die Kanzlei übernommen.'
          : 'Die Standardverbindung wird bei ELSTER vorausgewählt.'}
      </p>
      <div>
        <label className="label" htmlFor={`${prefix}-vat`}>
          USt-ID
        </label>
        <input
          id={`${prefix}-vat`}
          className="input"
          maxLength={20}
          value={draft.vatId}
          disabled={blocked}
          onChange={(e) => setDraft({ ...draft, vatId: e.target.value })}
        />
      </div>
      {draft.registrations.map((row, index) => {
        let normalized = '';
        try {
          normalized = row.number ? normalizeTaxNumber(row.number, row.stateCode) : '';
        } catch {
          /* Server returns a precise validation error on save. */
        }
        const rowId = `${prefix}-${index}`;
        return (
          <fieldset
            key={row.id ?? index}
            className="border border-subtle rounded-lg p-4 space-y-3"
            disabled={blocked}
          >
            <legend className="text-sm font-medium px-1">Steuerverbindung {index + 1}</legend>
            <div>
              <label className="label" htmlFor={`${rowId}-label`}>
                Bezeichnung / Zweck
              </label>
              <input
                id={`${rowId}-label`}
                className="input"
                value={row.label}
                maxLength={100}
                onChange={(e) => updateRow(index, { label: e.target.value })}
                placeholder="z. B. Umsatzsteuer"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor={`${rowId}-state`}>
                  Bundesland (für Länderformat)
                </label>
                <select
                  id={`${rowId}-state`}
                  className="input"
                  value={row.stateCode}
                  onChange={(e) => updateRow(index, { stateCode: e.target.value })}
                >
                  <option value="">ELSTER-Format ohne Landesauswahl</option>
                  {TAX_STATES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`${rowId}-number`}>
                  Steuernummer
                </label>
                <input
                  id={`${rowId}-number`}
                  className="input font-mono"
                  value={row.number}
                  maxLength={30}
                  onChange={(e) => updateRow(index, { number: e.target.value })}
                  aria-describedby={`${rowId}-number-hint`}
                />
                <p id={`${rowId}-number-hint`} className="text-xs text-muted mt-1">
                  Länderformat mit / oder 13 Ziffern. {normalized && `ELSTER: ${normalized}`}
                </p>
              </div>
            </div>
            <div>
              <label className="label" htmlFor={`${rowId}-office`}>
                Zuständiges Finanzamt
              </label>
              <input
                id={`${rowId}-office`}
                className="input"
                value={row.taxOfficeName}
                maxLength={200}
                onChange={(e) => updateRow(index, { taxOfficeName: e.target.value })}
              />
              <p className="text-xs text-muted mt-1">
                Manuell nach Aktenlage; die Nummernprüfung bestätigt keine Zuständigkeit.
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${prefix}-primary`}
                  checked={row.isPrimary}
                  onChange={() =>
                    setDraft({
                      ...draft,
                      registrations: draft.registrations.map((entry, i) => ({
                        ...entry,
                        isPrimary: i === index,
                      })),
                    })
                  }
                />
                Standardverbindung
              </label>
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={() =>
                  setDraft((value) => {
                    const rows = value.registrations.filter((_, i) => i !== index);
                    if (row.isPrimary && rows[0]) rows[0] = { ...rows[0], isPrimary: true };
                    return { ...value, registrations: rows };
                  })
                }
              >
                Verbindung archivieren
              </button>
            </div>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="btn-secondary"
        disabled={blocked || draft.registrations.length >= 50}
        onClick={() =>
          setDraft({
            ...draft,
            registrations: [
              ...draft.registrations,
              {
                label: '',
                stateCode: '',
                number: '',
                taxOfficeName: '',
                isPrimary: draft.registrations.length === 0,
              },
            ],
          })
        }
      >
        Steuerverbindung hinzufügen
      </button>
      {portal && (
        <div>
          <label className="label" htmlFor={`${prefix}-note`}>
            Nachricht an die Kanzlei
          </label>
          <textarea
            id={`${prefix}-note`}
            className="input"
            maxLength={500}
            value={note}
            disabled={blocked}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={message.ok ? 'alert-success-sm' : 'alert-error-sm'}
        >
          {message.text}
        </p>
      )}
      {disabled && (
        <p className="text-sm text-muted">Eine Stammdatenänderung wird bereits geprüft.</p>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={blocked} onClick={submit}>
          {pending
            ? 'Speichert…'
            : portal
              ? 'Steuerdatenänderung einreichen'
              : 'Steuerdaten speichern'}
        </button>
      </div>
    </section>
  );
}
