'use client';

// =============================================================================
// Kontoabfrage-Formular — Art (Sollstellungen/offene Beträge/Istbuchungen),
// Steuerart/Zeitraum je nach Art, PIN (nie gespeichert), Test-/Echtfall.
// =============================================================================

import { useActionState, useState } from 'react';
import type { ActionResult } from '@/server/actions/types';
import { kontoabfrageAction } from './actions';

const STEUERARTEN = ['ESt', 'KSt', 'USt', 'LSt', 'GewSt', 'ZaSt', 'KapESt'] as const;

export function KontoabfrageForm({ clientId }: { clientId: string }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    kontoabfrageAction,
    null,
  );
  const [art, setArt] = useState<'ZS' | 'O' | 'I'>('ZS');
  const [echtfall, setEchtfall] = useState(false);

  return (
    <form action={formAction} className="card p-6 space-y-4">
      <input type="hidden" name="clientId" value={clientId} />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-sm" htmlFor="elster-kontoabfrage-art">
            Abfrageart *
          </label>
          <select
            id="elster-kontoabfrage-art"
            name="art"
            value={art}
            onChange={(e) => setArt(e.target.value as 'ZS' | 'O' | 'I')}
            className="input w-full"
          >
            <option value="ZS">Sollstellungen (Jahr)</option>
            <option value="O">Offene Beträge</option>
            <option value="I">Istbuchungen (ab Datum)</option>
          </select>
        </div>

        {art !== 'O' && (
          <div>
            <label className="label-sm" htmlFor="elster-kontoabfrage-steuerart">
              Steuerart {art === 'ZS' ? '*' : ''}
              {art === 'I' && <span className="text-disabled font-normal"> (leer = alle)</span>}
            </label>
            <select
              id="elster-kontoabfrage-steuerart"
              name="steuerart"
              className="input w-full"
              defaultValue={art === 'ZS' ? 'ESt' : ''}
            >
              {art === 'I' && <option value="">— alle —</option>}
              {STEUERARTEN.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        {art === 'ZS' && (
          <div>
            <label className="label-sm" htmlFor="elster-kontoabfrage-jahr">
              Jahr *
            </label>
            <input
              id="elster-kontoabfrage-jahr"
              name="jahr"
              maxLength={4}
              pattern="[0-9]{4}"
              inputMode="numeric"
              placeholder="2026"
              className="input w-full"
              required
            />
          </div>
        )}

        {art === 'I' && (
          <>
            <div>
              <label className="label-sm" htmlFor="elster-kontoabfrage-wertstellungsdatum">
                Wertstellungsdatum * (TTMMJJJJ)
              </label>
              <input
                id="elster-kontoabfrage-wertstellungsdatum"
                name="wertstellungsdatum"
                maxLength={8}
                pattern="[0-9]{8}"
                inputMode="numeric"
                placeholder="01012026"
                className="input w-full"
                required
              />
            </div>
            <div>
              <label className="label-sm" htmlFor="elster-kontoabfrage-datumsoption">
                Datums-Option *
              </label>
              <select
                id="elster-kontoabfrage-datumsoption"
                name="wertstellungsdatumOption"
                className="input w-full"
                defaultValue="V"
              >
                <option value="V">ab diesem Datum</option>
                <option value="J">genau dieses Datum</option>
              </select>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label-sm" htmlFor="elster-kontoabfrage-pin">
            PIN des Portalzertifikats *
          </label>
          <input
            id="elster-kontoabfrage-pin"
            type="password"
            name="pin"
            autoComplete="off"
            className="input w-full"
            required
            aria-describedby="elster-kontoabfrage-pin-hint"
          />
          <p id="elster-kontoabfrage-pin-hint" className="text-xs text-muted mt-1">
            Wird nur für diesen Vorgang an die Bridge durchgereicht — nie gespeichert.
          </p>
        </div>
        {!echtfall && (
          <div>
            <label className="label-sm" htmlFor="elster-kontoabfrage-testmerker">
              Testmerker *
            </label>
            <input
              id="elster-kontoabfrage-testmerker"
              name="testmerker"
              maxLength={20}
              className="input w-full font-mono"
              placeholder="laut ERiC-/Bridge-Doku"
              required={!echtfall}
              aria-describedby="elster-kontoabfrage-testmerker-hint"
            />
            <p id="elster-kontoabfrage-testmerker-hint" className="text-xs text-muted mt-1">
              Test-Übertragung: die Clearingstelle validiert und verwirft.
            </p>
          </div>
        )}
      </div>

      <label className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 p-3 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          name="echtfall"
          checked={echtfall}
          onChange={(e) => setEchtfall(e.target.checked)}
          className="mt-0.5 rounded border-strong text-red-600"
        />
        <span>
          <strong className="text-red-800 dark:text-red-300">Echtfall</strong>{' '}
          <span className="text-red-700 dark:text-red-400">
            — echter Vorgang beim ELSTER-Server (kein Test). Ohne Häkchen wird als Test übertragen.
          </span>
        </span>
      </label>

      {state && !state.ok && state.error && (
        <div
          className="rounded-md bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div
          className="rounded-md bg-green-50 dark:bg-green-950/40 p-3 text-sm text-green-700 dark:text-green-300"
          role="status"
        >
          Abfrage übermittelt — Ergebnis siehe Historie unten.
        </div>
      )}

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Fragt ab… (bis 2 Min.)' : 'Steuerkonto abfragen'}
        </button>
      </div>
    </form>
  );
}
