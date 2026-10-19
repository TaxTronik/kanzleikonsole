'use client';

// Formular „Zuständigkeiten ändern“ einer Kontrolle (TCMS Stufe 3, Demo
// components/kontrollen/drawer.tsx). Zur Auswahl stehen nur Personen, die die
// Seite aus der kanzleikonsole lädt (Kanzlei: Zugriff auf den Mandanten;
// Mandant: aktive Kontakte mit Rolle); die Aktion prüft jede ID erneut, der
// Dienst prüft Vier-Augen und Pflichtangaben.
import { useId, useState } from 'react';
import { FieldError, fieldErrorProps, FormErrorSummary } from '@/components/form-errors';
import type { TcmsAktion } from '../bereich-b/ergebnis';
import { useTcmsFormular } from '../bereich-b/formular';

export interface PersonOption {
  id: string;
  name: string;
  funktion: string | null;
}

function Personenwahl({
  id,
  name,
  label,
  personen,
  wert,
  leer,
  fieldErrors,
  deaktiviert,
}: {
  id: string;
  name: string;
  label: string;
  personen: readonly PersonOption[];
  wert: string | null;
  leer?: string;
  fieldErrors: Record<string, string[]> | undefined;
  deaktiviert?: boolean;
}) {
  const bekannt = !wert || personen.some((p) => p.id.toLowerCase() === wert.toLowerCase());
  return (
    <div>
      <label htmlFor={`${id}-${name}`} className="label-sm">
        {label}
      </label>
      <select
        id={`${id}-${name}`}
        name={name}
        className="input"
        defaultValue={wert && bekannt ? wert.toLowerCase() : ''}
        required={!leer}
        disabled={deaktiviert}
        {...fieldErrorProps(name, fieldErrors, { prefix: id })}
      >
        <option value="" disabled={!leer}>
          {leer ?? 'bitte wählen'}
        </option>
        {personen.map((p) => (
          <option key={p.id} value={p.id.toLowerCase()}>
            {p.name}
            {p.funktion ? ` · ${p.funktion}` : ''}
          </option>
        ))}
      </select>
      {!bekannt ? (
        <p className="hint">Die bisher eingetragene Person steht nicht zur Auswahl.</p>
      ) : null}
      <FieldError name={name} errors={fieldErrors?.[name]} prefix={id} />
    </div>
  );
}

export function ZustaendigkeitFormular({
  aktion,
  kontrolleId,
  standId,
  partei,
  parteiLabel,
  schluessel,
  seitePersonen,
  kanzleiPersonen,
  durchfuehrendId,
  vertretungId,
  gegenzeichnerId,
  gegenzeichnungMandant,
  gesperrt,
}: {
  aktion: TcmsAktion;
  kontrolleId: string;
  standId: string;
  partei: 'KANZLEI' | 'MANDANT';
  parteiLabel: string;
  schluessel: boolean;
  seitePersonen: readonly PersonOption[];
  kanzleiPersonen: readonly PersonOption[];
  durchfuehrendId: string | null;
  vertretungId: string | null;
  gegenzeichnerId: string | null;
  gegenzeichnungMandant: boolean;
  gesperrt: string | null;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  const [beimMandanten, setBeimMandanten] = useState(gegenzeichnungMandant);
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form
      {...formular}
      // Nach Erfolg setzt useTcmsFormular das Formular auf die neuen Werte zurück.
      onReset={() => setBeimMandanten(gegenzeichnungMandant)}
      className="space-y-3"
      aria-label="Zuständigkeiten ändern"
    >
      <input type="hidden" name="kontrolleId" value={kontrolleId} />
      <input type="hidden" name="standId" value={standId} />
      <input type="hidden" name="partei" value={partei} />
      {ergebnis && !ergebnis.ok ? (
        <FormErrorSummary
          title="Zuständigkeiten nicht gespeichert."
          {...(ergebnis.error ? { error: ergebnis.error } : {})}
          {...(fieldErrors ? { fieldErrors } : {})}
        />
      ) : null}
      {ergebnis?.ok ? (
        <p className="alert-success-sm" role="status">
          {ergebnis.meldung}
        </p>
      ) : null}
      <fieldset disabled={gesperrt !== null || laeuft} className="space-y-3">
        <legend className="sr-only">Zuständige Personen</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Personenwahl
            id={id}
            name="durchfuehrendId"
            label={`Durchführend (${parteiLabel})`}
            personen={seitePersonen}
            wert={durchfuehrendId}
            fieldErrors={fieldErrors}
          />
          <Personenwahl
            id={id}
            name="vertretungId"
            label={`Vertretung (${parteiLabel})`}
            personen={seitePersonen}
            wert={vertretungId}
            fieldErrors={fieldErrors}
          />
          <Personenwahl
            id={id}
            name="gegenzeichnerId"
            label="Gegenzeichnung (Kanzlei)"
            personen={kanzleiPersonen}
            wert={gegenzeichnerId}
            fieldErrors={fieldErrors}
            deaktiviert={beimMandanten}
            {...(schluessel ? {} : { leer: '– keine –' })}
          />
          {partei === 'MANDANT' ? (
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-sm" htmlFor={`${id}-gzm`}>
                <input
                  id={`${id}-gzm`}
                  type="checkbox"
                  name="gegenzeichnungMandant"
                  value="on"
                  defaultChecked={gegenzeichnungMandant}
                  onChange={(e) => setBeimMandanten(e.target.checked)}
                  {...fieldErrorProps('gegenzeichnungMandant', fieldErrors, { prefix: id })}
                />
                Gegenzeichnung durch die Vertretung beim Mandanten
              </label>
            </div>
          ) : null}
        </div>
        <p className="hint">
          Die Gegenzeichnung erfolgt nie durch die durchführende Person derselben Durchführung;
          Schlüsselkontrollen brauchen eine Gegenzeichnung. Die Änderung erzeugt einen neuen
          Kontrollstand.
        </p>
        <div className="form-actions">
          <button
            type="submit"
            className="btn-primary text-xs py-1"
            aria-busy={laeuft}
            title={gesperrt ?? undefined}
          >
            {laeuft ? 'Wird gespeichert …' : 'Zuständigkeiten speichern'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
