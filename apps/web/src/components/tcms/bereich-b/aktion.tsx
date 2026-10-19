'use client';

// =============================================================================
// Aktions-Bausteine des Bereichs B (TCMS Stufe 3, portiert aus der Demo
// components/ui/client.tsx: BegruendungsDialog, AktionsForm, SubmitButton).
//
// - BegruendungsDialog: Schaltfläche öffnet einen Dialog (Modal der
//   kanzleikonsole: Fokusfalle, Esc, Fokus-Rückgabe) mit Zusatzfeldern und
//   Pflichtbegründung. Mindestlänge aus @taxtronik/tcms-domain
//   (`MIN_BEGRUENDUNG`); geprüft wird sie von der Aktion und vom Dienst, das
//   Formular zeigt sie nur an. Jede Öffnung beginnt mit leerem Formular.
// - AktionsKnopf: ein Klick ohne Eingabe (z. B. „Freigeben“).
// Ergebnis: Fehler als Fehlerzusammenfassung (role=alert, fokussiert) und
// Feldfehler am Feld, Eingaben bleiben stehen (useTcmsFormular); Erfolg als
// feste Meldung (role=status) neben dem Auslöser. Die Aktion bekommt Mandant und Objekt-IDs gebunden bzw. als
// verborgene Felder; Rechte und Vier-Augen prüft der Dienst.
// =============================================================================

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MIN_BEGRUENDUNG } from '@taxtronik/tcms-domain';
import {
  FieldError,
  FieldErrorsProvider,
  fieldErrorProps,
  FormErrorSummary,
  useFieldErrors,
} from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import type { TcmsAktion } from './ergebnis';
import { useTcmsFormular } from './formular';

/** Höchstlänge einer Begründung wie im Vertrag (`MAX_BEGRUENDUNG_ZEICHEN`). */
export const MAX_BEGRUENDUNG = 2000;

function VerborgeneFelder({ felder }: { felder?: Readonly<Record<string, string>> }) {
  return (
    <>
      {Object.entries(felder ?? {}).map(([name, wert]) => (
        <input key={name} type="hidden" name={name} value={wert} />
      ))}
    </>
  );
}

function Erfolg({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="alert-success-sm mt-2" role="status">
      {text}
    </p>
  );
}

export interface BegruendungsDialogProps {
  /** Beschriftung der auslösenden Schaltfläche. */
  ausloeser: ReactNode;
  ausloeserKlasse?: string;
  titel: string;
  hinweis?: ReactNode;
  aktion: TcmsAktion;
  felder?: Readonly<Record<string, string>>;
  bestaetigen?: string;
  /** Beschriftung des Begründungsfelds. */
  begruendungLabel?: string;
  /** true: Hinweis „Wird von einer zweiten Person bestätigt“. */
  vierAugen?: boolean;
  /** Bestätigen als Gefahrenschaltfläche (Ablehnen, Zurückweisen, Aufheben). */
  gefahr?: boolean;
  /** Grund, warum die Schaltfläche gesperrt ist; `null` = bedienbar. */
  gesperrt?: string | null;
  /** Zusatzfelder (Auswahl, Haken) vor der Begründung. */
  children?: ReactNode;
}

export function BegruendungsDialog(props: BegruendungsDialogProps) {
  const [offen, setOffen] = useState(false);
  const [oeffnung, setOeffnung] = useState(0);
  const [meldung, setMeldung] = useState<string | null>(null);
  const gesperrt = props.gesperrt ?? null;
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        className={props.ausloeserKlasse ?? 'btn-secondary text-xs py-1'}
        disabled={gesperrt !== null}
        title={gesperrt ?? undefined}
        aria-haspopup="dialog"
        onClick={() => {
          setMeldung(null);
          setOeffnung((n) => n + 1);
          setOffen(true);
        }}
      >
        {props.ausloeser}
      </button>
      <Erfolg text={meldung} />
      {offen ? (
        <Modal title={props.titel} onClose={() => setOffen(false)} maxWidth="max-w-lg">
          <DialogFormular
            key={oeffnung}
            {...props}
            onAbbrechen={() => setOffen(false)}
            onErfolg={(text) => {
              setOffen(false);
              setMeldung(text);
            }}
          />
        </Modal>
      ) : null}
    </span>
  );
}

function DialogFormular({
  titel,
  hinweis,
  aktion,
  felder,
  bestaetigen = 'Absenden',
  begruendungLabel = 'Begründung',
  vierAugen = true,
  gefahr = false,
  children,
  onAbbrechen,
  onErfolg,
}: BegruendungsDialogProps & {
  onAbbrechen: () => void;
  onErfolg: (meldung: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  const erfolgGemeldet = useRef(false);
  useEffect(() => {
    if (ergebnis?.ok && !erfolgGemeldet.current) {
      erfolgGemeldet.current = true;
      onErfolg(ergebnis.meldung ?? 'Gespeichert.');
    }
  }, [ergebnis, onErfolg]);
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  const hinweisId = `${id}-begruendung-hinweis`;
  const laenge = text.trim().length;
  return (
    <form {...formular} className="space-y-3">
      <h2 className="text-base font-semibold text-primary pr-8">{titel}</h2>
      {hinweis ? <p className="text-sm text-secondary">{hinweis}</p> : null}
      {ergebnis && !ergebnis.ok ? (
        <FormErrorSummary
          title="Nicht gespeichert."
          {...(ergebnis.error ? { error: ergebnis.error } : {})}
          {...(fieldErrors ? { fieldErrors } : {})}
        />
      ) : null}
      <VerborgeneFelder felder={felder} />
      <FieldErrorsProvider fieldErrors={fieldErrors}>{children}</FieldErrorsProvider>
      <div>
        <label htmlFor={`${id}-begruendung`} className="label">
          {begruendungLabel}
        </label>
        <textarea
          id={`${id}-begruendung`}
          name="begruendung"
          className="input min-h-28"
          required
          minLength={MIN_BEGRUENDUNG}
          maxLength={MAX_BEGRUENDUNG}
          value={text}
          onChange={(e) => setText(e.target.value)}
          {...fieldErrorProps('begruendung', fieldErrors, { prefix: id, describedBy: hinweisId })}
        />
        <FieldError name="begruendung" errors={fieldErrors?.begruendung} prefix={id} />
        <p id={hinweisId} className="hint flex justify-between gap-3">
          <span>
            Mindestens {MIN_BEGRUENDUNG} Zeichen.{' '}
            {vierAugen
              ? 'Wirksam erst nach Bestätigung durch eine zweite Person.'
              : 'Wird mit Name und Zeitpunkt protokolliert.'}
          </span>
          <span className="font-mono" aria-hidden="true">
            {laenge}/{MIN_BEGRUENDUNG}
          </span>
        </p>
      </div>
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onAbbrechen} disabled={laeuft}>
          Abbrechen
        </button>
        <button
          type="submit"
          className={gefahr ? 'btn-danger-outline' : 'btn-primary'}
          disabled={laeuft}
          aria-busy={laeuft}
        >
          {laeuft ? 'Wird übertragen …' : bestaetigen}
        </button>
      </div>
    </form>
  );
}

export function AktionsKnopf({
  aktion,
  felder,
  beschriftung,
  klasse = 'btn-primary text-xs py-1',
  gesperrt,
}: {
  aktion: TcmsAktion;
  felder?: Readonly<Record<string, string>>;
  beschriftung: ReactNode;
  klasse?: string;
  gesperrt?: string | null;
}) {
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  const sperre = gesperrt ?? null;
  return (
    <form {...formular} className="inline-flex flex-col items-start">
      <VerborgeneFelder felder={felder} />
      <button
        type="submit"
        className={klasse}
        disabled={sperre !== null || laeuft}
        title={sperre ?? undefined}
        aria-busy={laeuft}
      >
        {beschriftung}
      </button>
      {ergebnis && !ergebnis.ok ? (
        <div className="mt-2">
          <FormErrorSummary
            title="Nicht ausgeführt."
            {...(ergebnis.error ? { error: ergebnis.error } : {})}
            {...(ergebnis.fieldErrors ? { fieldErrors: ergebnis.fieldErrors } : {})}
          />
        </div>
      ) : null}
      <Erfolg text={ergebnis?.ok ? (ergebnis.meldung ?? 'Gespeichert.') : null} />
    </form>
  );
}

/** Auswahlfeld eines Dialogs; Feldfehler aus dem umgebenden Dialogformular. */
export function AuswahlFeld({
  name,
  label,
  optionen,
  defaultValue,
  platzhalter,
}: {
  name: string;
  label: string;
  optionen: ReadonlyArray<{ wert: string; label: string; deaktiviert?: boolean }>;
  defaultValue?: string;
  /** Leere, nicht wählbare Vorauswahl („bitte wählen“) – keine Vorbelegung. */
  platzhalter?: string;
}) {
  const id = useId();
  const fieldErrors = useFieldErrors();
  return (
    <div>
      <label htmlFor={`${id}-${name}`} className="label-sm">
        {label}
      </label>
      <select
        id={`${id}-${name}`}
        name={name}
        className="input"
        required
        defaultValue={defaultValue ?? (platzhalter ? '' : undefined)}
        {...fieldErrorProps(name, fieldErrors, { prefix: id })}
      >
        {platzhalter ? (
          <option value="" disabled>
            {platzhalter}
          </option>
        ) : null}
        {optionen.map((o) => (
          <option key={o.wert} value={o.wert} disabled={o.deaktiviert}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldError name={name} errors={fieldErrors?.[name]} prefix={id} />
    </div>
  );
}

/** Kontrollkästchen eines Dialogs mit Feldfehler. */
export function HakenFeld({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  const id = useId();
  const fieldErrors = useFieldErrors();
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-sm" htmlFor={`${id}-${name}`}>
        <input
          id={`${id}-${name}`}
          type="checkbox"
          name={name}
          value="on"
          defaultChecked={defaultChecked}
          {...fieldErrorProps(name, fieldErrors, { prefix: id })}
        />
        {label}
      </label>
      <FieldError name={name} errors={fieldErrors?.[name]} prefix={id} />
    </div>
  );
}

/** Gleichrangige Optionen ohne Vorauswahl (Radiogruppe mit Legende). */
export function OptionenFeld({
  name,
  legende,
  optionen,
}: {
  name: string;
  legende: string;
  optionen: ReadonlyArray<{ wert: string; label: string }>;
}) {
  const id = useId();
  const fieldErrors = useFieldErrors();
  return (
    <fieldset {...fieldErrorProps(name, fieldErrors, { prefix: id })}>
      <legend className="label-sm">{legende}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {optionen.map((o) => (
          <label key={o.wert} className="inline-flex items-center gap-2 text-sm">
            <input type="radio" name={name} value={o.wert} required />
            {o.label}
          </label>
        ))}
      </div>
      <FieldError name={name} errors={fieldErrors?.[name]} prefix={id} />
    </fieldset>
  );
}
