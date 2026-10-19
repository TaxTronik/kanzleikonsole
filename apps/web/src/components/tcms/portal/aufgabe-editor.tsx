'use client';

// =============================================================================
// Kontrollaufgabe im Portal bearbeiten (TCMS Stufe 3, Bereich D; aus der Demo
// components/durchfuehrung/editor.tsx, Variante „portal“, und
// components/durchfuehrung/formulare.tsx, EntwurfFormular).
//
// Schritte, Werte und Ergebnis gehören über das `form`-Attribut zum Formular
// der Fußleiste („Entwurf speichern“ / „Übermitteln“); dazwischen steht die
// Anlagen-Karte mit ihrem eigenen Upload-Formular (Slot). Absenden ohne Reset,
// damit Eingaben bei einer Ablehnung erhalten bleiben.
//
// Abweichung von der Demo: keine Toleranz- und Differenzrechnung im Browser.
// Ob ein Wert außerhalb der Toleranz liegt, meldet das Tax-CMS (`pruefung.
// ausserhalb` des gespeicherten Stands); Differenzkennzahlen berechnet nur der
// Dienst und zeigt die Seite als „wird berechnet“.
// =============================================================================

import { useId, useState, type ReactNode } from 'react';
import { Send, Save, TriangleAlert, Check } from 'lucide-react';
import { fmtEur } from '@taxtronik/tcms-domain';
import { FieldError, fieldErrorProps } from '@/components/form-errors';
import { TcmsErgebnisMeldung, useTcmsAbsenden, type TcmsFormAktion } from '../ereignisse/aktionen';
import { alsEingabe } from './werte';

export interface EditorSchritt {
  titel: string;
  hinweis: string;
  erledigt: boolean;
  kommentar: string;
}

export interface EditorKennzahl {
  key: string;
  label: string;
  sollEur: number | null;
  differenzAus?: [string, string] | undefined;
}

export interface EditorWert {
  key: string;
  wert: number | null;
  bemerkung: string;
  erklaert: boolean;
}

type ErgebnisWahl = 'OHNE_BEFUND' | 'MIT_BEFUND';

const OPTIONEN: ReadonlyArray<{
  wert: ErgebnisWahl;
  text: string;
  ton: string;
  Icon: typeof Check;
}> = [
  {
    wert: 'OHNE_BEFUND',
    text: 'keine Auffälligkeiten festgestellt',
    ton: 'chip-green',
    Icon: Check,
  },
  {
    wert: 'MIT_BEFUND',
    text: 'Auffälligkeiten festgestellt (bitte kommentieren)',
    ton: 'chip-amber',
    Icon: TriangleAlert,
  },
];

/** Kennzahlen der Kontrolle mit Werten, Soll und Bemerkung. */
function WerteKarte({
  formId,
  form,
  kannSenden,
  kennzahlen,
  werte,
  ausserhalb,
  toleranzEur,
  periodeLabel,
  fieldErrors,
}: {
  formId: string;
  form: string | undefined;
  kannSenden: boolean;
  kennzahlen: readonly EditorKennzahl[];
  werte: readonly EditorWert[];
  ausserhalb: readonly string[];
  toleranzEur: number | null;
  periodeLabel: string;
  fieldErrors: Record<string, string[]> | undefined;
}) {
  const wertJe = new Map(werte.map((w) => [w.key, w]));
  const f = form;
  return (
    <section className="card overflow-x-auto" aria-labelledby={`${formId}-werte`}>
      <div className="card-header">
        <h2 id={`${formId}-werte`} className="text-sm font-semibold text-primary">
          Werte
        </h2>
        <span className="text-xs text-muted">
          Beträge in Euro
          {toleranzEur != null ? ` · Toleranz ±${fmtEur(toleranzEur)}` : ''}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className="th">
              Kennzahl
            </th>
            <th scope="col" className="th text-right">
              Wert {periodeLabel}
            </th>
            <th scope="col" className="th text-right">
              Soll
            </th>
            <th scope="col" className="th">
              Bemerkung
            </th>
          </tr>
        </thead>
        <tbody>
          {kennzahlen.map((k) => {
            const w = wertJe.get(k.key);
            const feld = `wert_${k.key}`;
            const istAusserhalb = ausserhalb.includes(k.label);
            return (
              <tr key={k.key} className="border-t border-default align-top">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  {k.label}
                  {istAusserhalb ? (
                    <span className="badge-red ml-2">außerhalb der Toleranz</span>
                  ) : null}
                </th>
                <td className="px-4 py-2 td-num">
                  {k.differenzAus ? (
                    <span className="text-xs text-muted">wird vom Tax-CMS berechnet</span>
                  ) : kannSenden ? (
                    <>
                      <input
                        id={`${formId}-${feld}`}
                        className="input font-mono text-right w-36"
                        name={feld}
                        form={f}
                        inputMode="decimal"
                        defaultValue={alsEingabe(w?.wert)}
                        placeholder="0,00"
                        aria-label={k.label}
                        {...fieldErrorProps(feld, fieldErrors, { prefix: formId })}
                      />
                      <FieldError name={feld} errors={fieldErrors?.[feld]} prefix={formId} />
                    </>
                  ) : (
                    fmtEur(w?.wert ?? null)
                  )}
                </td>
                <td className="px-4 py-2 td-num text-muted">
                  {k.sollEur != null ? fmtEur(k.sollEur) : '—'}
                </td>
                <td className="px-4 py-2 min-w-[14rem]">
                  {kannSenden ? (
                    <div className="space-y-1">
                      <input
                        className="input text-sm"
                        name={`bemerkung_${k.key}`}
                        form={f}
                        defaultValue={w?.bemerkung ?? ''}
                        placeholder="Erläuterung einer Abweichung"
                        aria-label={`Bemerkung ${k.label}`}
                        maxLength={1000}
                      />
                      <label className="inline-flex items-center gap-1.5 text-xs text-secondary">
                        <input
                          type="checkbox"
                          name={`erklaert_${k.key}`}
                          form={f}
                          defaultChecked={w?.erklaert ?? false}
                        />
                        Abweichung erklärt
                      </label>
                    </div>
                  ) : w?.bemerkung ? (
                    w.bemerkung
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint px-4 pb-3">
        Ob ein Wert außerhalb der Toleranz liegt, prüft das Tax-CMS beim Speichern.
      </p>
    </section>
  );
}

export function AufgabeEditor({
  aktion,
  bearbeitbar,
  sperrGrund,
  schritte,
  kennzahlen,
  werte,
  ausserhalb,
  toleranzEur,
  periodeLabel,
  ergebnis,
  ergebnisKommentar,
  minBefund,
  einreichenLabel,
  fussleiste,
  anlagen,
}: {
  /** Speichern/Übermitteln (gebunden an die Aufgabe); null: keine Bearbeitung. */
  aktion: TcmsFormAktion | null;
  bearbeitbar: boolean;
  /** Grund laut Dienst, warum nicht bearbeitet werden kann. */
  sperrGrund: string | null;
  schritte: readonly EditorSchritt[];
  kennzahlen: readonly EditorKennzahl[];
  werte: readonly EditorWert[];
  /** Kennzahlen außerhalb der Toleranz laut Prüfung des Dienstes. */
  ausserhalb: readonly string[];
  toleranzEur: number | null;
  periodeLabel: string;
  ergebnis: ErgebnisWahl | null;
  ergebnisKommentar: string | null;
  minBefund: number;
  einreichenLabel: string;
  /** Fußleiste anzeigen (offene Aufgabe); gesperrt mit Grund, wenn nicht bearbeitbar. */
  fussleiste: boolean;
  anlagen: ReactNode;
}) {
  const formId = useId();
  const kannSenden = bearbeitbar && aktion !== null;
  const f = kannSenden ? formId : undefined;
  const [erledigt, setErledigt] = useState(() => schritte.map((s) => s.erledigt));
  const {
    ergebnis: antwort,
    laeuft,
    onSubmit,
  } = useTcmsAbsenden(
    aktion ?? (async () => ({ ok: false, error: sperrGrund ?? 'Bearbeitung nicht möglich.' })),
  );
  const fieldErrors = antwort && !antwort.ok ? antwort.fieldErrors : undefined;
  const anzahlErledigt = erledigt.filter(Boolean).length;
  const alleErledigt = schritte.length > 0 && anzahlErledigt === schritte.length;

  return (
    <>
      <section className="card" aria-labelledby={`${formId}-schritte`}>
        <div className="card-header">
          <h2 id={`${formId}-schritte`} className="text-sm font-semibold text-primary">
            Schritte
          </h2>
          <span className={alleErledigt ? 'badge-green' : 'badge-gray'}>
            {anzahlErledigt} von {schritte.length} erledigt
          </span>
        </div>
        {schritte.length === 0 ? (
          <p className="p-6 text-sm text-muted">
            Für diese Kontrollversion sind keine Schritte hinterlegt.
          </p>
        ) : (
          <ol className="p-4 space-y-3">
            {schritte.map((s, i) => (
              <li key={i} className="rounded border border-default p-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    id={`${formId}-schritt-${i}`}
                    name={`schritt_${i}_erledigt`}
                    form={f}
                    className="mt-1"
                    checked={erledigt[i] ?? false}
                    disabled={!kannSenden}
                    onChange={(e) =>
                      setErledigt((alt) => alt.map((x, j) => (j === i ? e.target.checked : x)))
                    }
                  />
                  <label htmlFor={`${formId}-schritt-${i}`} className="grow">
                    <span className="block text-sm font-medium text-primary">
                      {i + 1} · {s.titel}
                    </span>
                    <span className="block text-xs text-muted mt-0.5">{s.hinweis}</span>
                  </label>
                </div>
                {kannSenden ? (
                  <input
                    className="input mt-2 text-sm"
                    name={`schritt_${i}_kommentar`}
                    form={f}
                    defaultValue={s.kommentar}
                    placeholder="Anmerkung (optional)"
                    aria-label={`Anmerkung zu Schritt ${i + 1}`}
                    maxLength={2000}
                  />
                ) : s.kommentar ? (
                  <p className="text-xs text-secondary mt-2">Anmerkung: {s.kommentar}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {kennzahlen.length > 0 ? (
        <WerteKarte
          formId={formId}
          form={f}
          kannSenden={kannSenden}
          kennzahlen={kennzahlen}
          werte={werte}
          ausserhalb={ausserhalb}
          toleranzEur={toleranzEur}
          periodeLabel={periodeLabel}
          fieldErrors={fieldErrors}
        />
      ) : null}

      {anlagen}

      <section className="card" aria-labelledby={`${formId}-ergebnis`}>
        <div className="card-header">
          <h2 id={`${formId}-ergebnis`} className="text-sm font-semibold text-primary">
            Ergebnis
          </h2>
        </div>
        <fieldset className="p-4 space-y-3">
          <legend className="sr-only">Ergebnis</legend>
          {OPTIONEN.map((o) => (
            <label
              key={o.wert}
              className="flex items-center gap-3 rounded border border-default p-3"
            >
              <span className={`kpi-chip ${o.ton}`}>
                <o.Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <input
                type="radio"
                name="ergebnis"
                value={o.wert}
                form={f}
                defaultChecked={ergebnis === o.wert}
                disabled={!kannSenden}
              />
              <span className="text-sm">{o.text}</span>
            </label>
          ))}
          {kannSenden ? (
            <div>
              <label htmlFor={`${formId}-kommentar`} className="label-sm">
                Kommentar zu den Auffälligkeiten
              </label>
              <textarea
                id={`${formId}-kommentar`}
                className="input min-h-[5rem]"
                name="ergebnisKommentar"
                form={f}
                defaultValue={ergebnisKommentar ?? ''}
                maxLength={4000}
                aria-describedby={`${formId}-kommentar-hinweis`}
              />
              <p id={`${formId}-kommentar-hinweis`} className="hint">
                Nur bei Auffälligkeiten erforderlich (mindestens {minBefund} Zeichen).
              </p>
            </div>
          ) : ergebnisKommentar ? (
            <p className="text-sm text-secondary whitespace-pre-wrap">{ergebnisKommentar}</p>
          ) : null}
        </fieldset>
      </section>

      {fussleiste ? (
        <div className="space-y-2">
          <TcmsErgebnisMeldung ergebnis={antwort} titel="Nicht gespeichert." />
          <form id={formId} onSubmit={onSubmit} className="form-actions flex-wrap">
            <button
              type="submit"
              name="absicht"
              value="speichern"
              className="btn-secondary"
              disabled={!kannSenden || laeuft}
              aria-busy={laeuft}
              aria-describedby={kannSenden ? undefined : `${formId}-sperre`}
            >
              <Save className="h-4 w-4" aria-hidden="true" /> Entwurf speichern
            </button>
            <button
              type="submit"
              name="absicht"
              value="einreichen"
              className="btn-primary"
              disabled={!kannSenden || laeuft}
              aria-busy={laeuft}
              aria-describedby={kannSenden ? undefined : `${formId}-sperre`}
            >
              <Send className="h-4 w-4" aria-hidden="true" /> {einreichenLabel}
            </button>
          </form>
          {!kannSenden && sperrGrund ? (
            <p id={`${formId}-sperre`} className="text-xs text-muted text-right">
              {sperrGrund}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
