'use client';

// =============================================================================
// Formulare der Feststellungen (TCMS Stufe 3, Bereich C; portiert aus der Demo
// components/feststellungen/{dialog,p153-block,vertraulich}.tsx und den
// Formularen der Feststellungsseiten). Aktionen sind Server Actions mit
// gebundenem Mandanten (und Objekt); Formulare tragen nur Eingaben. Dialoge
// nutzen `Modal` (Fokusfalle, Esc, Fokus-Rückgabe), Fehler erscheinen am Feld.
//
// §-153-Würdigung: vier gleichrangige Optionen ohne Vorauswahl und ohne
// Empfehlung, Begründung mindestens 30 Zeichen, Frist bei Berichtigung und
// weiterer Klärung. Ob die Person würdigen darf, entscheidet der Dienst; die
// Seite sperrt nur sichtbar mit Grund.
// =============================================================================

import { useActionState, useId, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { EyeOff, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  AUSWIRKUNG_LABEL,
  FESTSTELLUNG_KLASSE_LABEL,
  KLASSE_LABEL,
  QUELLE_LABEL,
  type Paragraph153Entscheidung,
} from '@taxtronik/tcms-domain';
import { FieldError, fieldErrorProps, type FieldErrors } from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import {
  Meldung,
  type TcmsErgebnis,
  type TcmsFormAktion,
} from '@/components/tcms/durchfuehrung/formulare';

function Absenden({
  children,
  className = 'btn-primary',
  disabled,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={disabled || pending} aria-busy={pending}>
      {pending ? 'Bitte warten …' : children}
    </button>
  );
}

/** Feld mit Beschriftung und Fehler (Fehler über `fieldErrorProps` am Eingabeelement). */
function Feld({
  id,
  name,
  label,
  fe,
  children,
}: {
  id: string;
  name: string;
  label: ReactNode;
  fe: FieldErrors | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label-sm" htmlFor={`${id}-${name}`}>
        {label}
      </label>
      {children}
      <FieldError name={name} errors={fe?.[name]} prefix={id} />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Dialog mit Formular
// ----------------------------------------------------------------------------

interface DialogAngaben {
  ausloeser: ReactNode;
  ausloeserClass?: string;
  titel: string;
  hinweis?: string;
  action: TcmsFormAktion;
  bestaetigen?: string;
  gefahr?: boolean;
  disabled?: boolean;
  disabledGrund?: string | null | undefined;
  breit?: boolean;
}

/**
 * Auslöser und Dialog. Der Dialog bleibt offen, bis die Aktion Erfolg meldet;
 * danach steht die Erfolgsmeldung neben dem Auslöser.
 */
function DialogFormular(
  props: DialogAngaben & {
    absendenGesperrt?: boolean;
    felder: (fe: FieldErrors | undefined, id: string) => ReactNode;
  },
) {
  const { ausloeser, action, disabled, disabledGrund } = props;
  const [ergebnis, aktion] = useActionState<TcmsErgebnis | null, FormData>(action, null);
  // Geöffnet mit dem Ergebnis zum Öffnungszeitpunkt; ein neuer Erfolg schließt.
  const [geoeffnet, setGeoeffnet] = useState<{ bei: TcmsErgebnis | null } | null>(null);
  const offen = geoeffnet !== null && !(ergebnis?.ok && ergebnis !== geoeffnet.bei);
  const grund = disabled ? (disabledGrund ?? undefined) : undefined;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        className={`${props.ausloeserClass ?? 'btn-secondary text-xs py-1'} inline-flex items-center gap-1`}
        onClick={() => setGeoeffnet({ bei: ergebnis })}
        disabled={disabled}
        title={grund}
        aria-haspopup="dialog"
      >
        {ausloeser}
      </button>
      {grund ? <span className="sr-only">{grund}</span> : null}
      {!offen && ergebnis?.ok && ergebnis.meldung ? (
        <p className="alert-success-sm max-w-md" role="status">
          {ergebnis.meldung}
        </p>
      ) : null}
      {offen ? (
        <DialogInhalt
          {...props}
          aktion={aktion}
          // Fehler nur aus Absendungen dieses Öffnens.
          ergebnis={ergebnis !== geoeffnet.bei ? ergebnis : null}
          schliessen={() => setGeoeffnet(null)}
        />
      ) : null}
    </span>
  );
}

function DialogInhalt({
  titel,
  hinweis,
  bestaetigen,
  gefahr,
  breit,
  absendenGesperrt,
  felder,
  aktion,
  ergebnis,
  schliessen,
}: DialogAngaben & {
  absendenGesperrt?: boolean;
  felder: (fe: FieldErrors | undefined, id: string) => ReactNode;
  aktion: (formData: FormData) => void;
  ergebnis: TcmsErgebnis | null;
  schliessen: () => void;
}) {
  const id = useId();
  const fe = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <Modal title={titel} onClose={schliessen} maxWidth={breit ? 'max-w-2xl' : 'max-w-lg'}>
      <h2 className="text-base font-semibold text-primary pr-8">{titel}</h2>
      {hinweis ? <p className="text-xs text-muted mt-1">{hinweis}</p> : null}
      <form action={aktion} className="mt-4 space-y-3">
        {ergebnis && !ergebnis.ok ? <Meldung ergebnis={ergebnis} /> : null}
        {felder(fe, id)}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={schliessen}>
            Abbrechen
          </button>
          <Absenden
            className={gefahr ? 'btn-danger-outline' : 'btn-primary'}
            disabled={absendenGesperrt === true}
          >
            {bestaetigen ?? 'Speichern'}
          </Absenden>
        </div>
      </form>
    </Modal>
  );
}

function Auswahl({
  werte,
  leer = 'bitte wählen',
}: {
  werte: ReadonlyArray<readonly [string, string]>;
  leer?: string | null;
}) {
  return (
    <>
      {leer !== null ? (
        <option value="" disabled>
          {leer}
        </option>
      ) : null}
      {werte.map(([wert, label]) => (
        <option key={wert} value={wert}>
          {label}
        </option>
      ))}
    </>
  );
}

const SCHWEREN = (['GERING', 'MITTEL', 'HOCH', 'KRITISCH'] as const).map(
  (k) => [k, KLASSE_LABEL[k]] as const,
);
const AUSWIRKUNGEN = (['JA', 'NEIN', 'UNKLAR'] as const).map(
  (k) => [k, AUSWIRKUNG_LABEL[k]] as const,
);
const KLASSEN = Object.entries(FESTSTELLUNG_KLASSE_LABEL) as Array<[string, string]>;
const QUELLEN = Object.entries(QUELLE_LABEL) as Array<[string, string]>;

// ----------------------------------------------------------------------------
// Feststellung erfassen
// ----------------------------------------------------------------------------

export function ErfassenDialog({
  action,
  disabled,
  disabledGrund,
  durchfuehrungen,
  risiken,
}: {
  action: TcmsFormAktion;
  disabled: boolean;
  disabledGrund: string | null;
  durchfuehrungen: ReadonlyArray<readonly [string, string]>;
  risiken: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <DialogFormular
      ausloeser="+ Feststellung erfassen"
      ausloeserClass="btn-primary text-xs py-1"
      titel="Feststellung erfassen"
      hinweis="Nummer wird automatisch vergeben (F-Jahr-lfd. Nr.). Bei steuerlicher Auswirkung „ja“ oder „unklar“ startet der §-153-Pfad."
      action={action}
      bestaetigen="Erfassen"
      breit
      disabled={disabled}
      disabledGrund={disabledGrund}
      felder={(fe, id) => (
        <>
          <Feld id={id} name="titel" label="Titel" fe={fe}>
            <input
              id={`${id}-titel`}
              name="titel"
              className="input"
              required
              minLength={5}
              maxLength={200}
              placeholder="z. B. Clearingkonto Klarna mit Restsaldo"
              {...fieldErrorProps('titel', fe, { prefix: id })}
            />
          </Feld>
          <Feld id={id} name="sachverhalt" label="Sachverhalt" fe={fe}>
            <textarea
              id={`${id}-sachverhalt`}
              name="sachverhalt"
              className="input"
              rows={4}
              required
              minLength={20}
              maxLength={4000}
              placeholder="Was wurde festgestellt? Wo, seit wann, in welchem Umfang?"
              {...fieldErrorProps('sachverhalt', fe, { prefix: id })}
            />
          </Feld>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Feld id={id} name="quelle" label="Quelle" fe={fe}>
              <select
                id={`${id}-quelle`}
                name="quelle"
                className="input"
                defaultValue="HINWEIS"
                {...fieldErrorProps('quelle', fe, { prefix: id })}
              >
                <Auswahl werte={QUELLEN} leer={null} />
              </select>
            </Feld>
            <div className="sm:col-span-2">
              <Feld id={id} name="quelleText" label="Quelle (Angabe)" fe={fe}>
                <input
                  id={`${id}-quelleText`}
                  name="quelleText"
                  className="input"
                  required
                  minLength={2}
                  maxLength={200}
                  placeholder="z. B. Hinweis Buchhaltung, Außenprüfung USt 2024"
                  {...fieldErrorProps('quelleText', fe, { prefix: id })}
                />
              </Feld>
            </div>
          </div>
          <Feld
            id={id}
            name="durchfuehrungId"
            label="Durchführung (nur bei Quelle Kontrolle, optional)"
            fe={fe}
          >
            <select
              id={`${id}-durchfuehrungId`}
              name="durchfuehrungId"
              className="input"
              defaultValue=""
              {...fieldErrorProps('durchfuehrungId', fe, { prefix: id })}
            >
              <option value="">— keine —</option>
              <Auswahl werte={durchfuehrungen} leer={null} />
            </select>
          </Feld>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Feld id={id} name="klasse" label="Klasse" fe={fe}>
              <select
                id={`${id}-klasse`}
                name="klasse"
                className="input"
                defaultValue=""
                required
                {...fieldErrorProps('klasse', fe, { prefix: id })}
              >
                <Auswahl werte={KLASSEN} />
              </select>
            </Feld>
            <Feld id={id} name="schwere" label="Schwere" fe={fe}>
              <select
                id={`${id}-schwere`}
                name="schwere"
                className="input"
                defaultValue=""
                required
                {...fieldErrorProps('schwere', fe, { prefix: id })}
              >
                <Auswahl werte={SCHWEREN} />
              </select>
            </Feld>
            <Feld id={id} name="auswirkung" label="Steuerliche Auswirkung" fe={fe}>
              <select
                id={`${id}-auswirkung`}
                name="auswirkung"
                className="input"
                defaultValue=""
                required
                {...fieldErrorProps('auswirkung', fe, { prefix: id })}
              >
                <Auswahl werte={AUSWIRKUNGEN} />
              </select>
            </Feld>
          </div>
          <Feld
            id={id}
            name="risiken"
            label="Betroffene Risiken (Mehrfachauswahl mit Strg/Cmd)"
            fe={fe}
          >
            <select
              id={`${id}-risiken`}
              name="risiken"
              multiple
              className="input min-h-[7.5rem]"
              {...fieldErrorProps('risiken', fe, { prefix: id })}
            >
              <Auswahl werte={risiken} leer={null} />
            </select>
          </Feld>
        </>
      )}
    />
  );
}

// ----------------------------------------------------------------------------
// Würdigung, Erklärung, Maßnahme, Erledigen, Nachkontrolle
// ----------------------------------------------------------------------------

export function WuerdigungDialog({
  action,
  sperre,
  schwere,
  auswirkung,
  auswirkungFest,
  ursache,
}: {
  action: TcmsFormAktion;
  sperre: string | null;
  schwere: string;
  auswirkung: string;
  /** Nach dokumentierter §-153-Würdigung ist die Auswirkung nicht mehr änderbar. */
  auswirkungFest: boolean;
  ursache: string | null;
}) {
  return (
    <DialogFormular
      ausloeser="Würdigung bearbeiten"
      titel="Würdigung: Schwere, Auswirkung, Ursache"
      hinweis="Bei steuerlicher Auswirkung „ja“ oder „unklar“ startet der §-153-Pfad. Nach dokumentierter Würdigung ist die Auswirkung nicht mehr änderbar."
      action={action}
      disabled={sperre !== null}
      disabledGrund={sperre}
      felder={(fe, id) => (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Feld id={id} name="schwere" label="Schwere" fe={fe}>
              <select
                id={`${id}-schwere`}
                name="schwere"
                className="input"
                defaultValue={schwere}
                {...fieldErrorProps('schwere', fe, { prefix: id })}
              >
                <Auswahl werte={SCHWEREN} leer={null} />
              </select>
            </Feld>
            <Feld id={id} name="auswirkung" label="Steuerliche Auswirkung" fe={fe}>
              <select
                id={`${id}-auswirkung`}
                name={auswirkungFest ? undefined : 'auswirkung'}
                className="input"
                defaultValue={auswirkung}
                disabled={auswirkungFest}
                {...fieldErrorProps('auswirkung', fe, { prefix: id })}
              >
                <Auswahl werte={AUSWIRKUNGEN} leer={null} />
              </select>
              {auswirkungFest ? <input type="hidden" name="auswirkung" value={auswirkung} /> : null}
            </Feld>
          </div>
          <Feld id={id} name="ursache" label="Ursache" fe={fe}>
            <textarea
              id={`${id}-ursache`}
              name="ursache"
              className="input"
              rows={3}
              maxLength={2000}
              defaultValue={ursache ?? ''}
              {...fieldErrorProps('ursache', fe, { prefix: id })}
            />
          </Feld>
        </>
      )}
    />
  );
}

export function ErklaerungDialog({
  action,
  sperre,
}: {
  action: TcmsFormAktion;
  sperre: string | null;
}) {
  return (
    <DialogFormular
      ausloeser="+ Erklärung"
      titel="Betroffene Erklärung erfassen"
      hinweis="§-153-Pfad Schritt 1: Steuerart, Land, Zeitraum, geschätzte Auswirkung."
      action={action}
      disabled={sperre !== null}
      disabledGrund={sperre}
      felder={(fe, id) => (
        <>
          <Feld id={id} name="steuerart" label="Steuerart / Erklärung" fe={fe}>
            <input
              id={`${id}-steuerart`}
              name="steuerart"
              className="input"
              required
              minLength={2}
              maxLength={120}
              placeholder="z. B. USt (OSS), ZM, USt-VA"
              {...fieldErrorProps('steuerart', fe, { prefix: id })}
            />
          </Feld>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Feld id={id} name="land" label="Land" fe={fe}>
              <input
                id={`${id}-land`}
                name="land"
                className="input"
                required
                minLength={2}
                maxLength={40}
                placeholder="DE"
                {...fieldErrorProps('land', fe, { prefix: id })}
              />
            </Feld>
            <Feld id={id} name="zeitraum" label="Zeitraum" fe={fe}>
              <input
                id={`${id}-zeitraum`}
                name="zeitraum"
                className="input"
                required
                minLength={2}
                maxLength={40}
                placeholder="Q3 2026"
                {...fieldErrorProps('zeitraum', fe, { prefix: id })}
              />
            </Feld>
            <Feld id={id} name="auswirkungEur" label="Geschätzte Auswirkung (€)" fe={fe}>
              <input
                id={`${id}-auswirkungEur`}
                name="auswirkungEur"
                className="input"
                inputMode="decimal"
                placeholder="leer = zu klären"
                {...fieldErrorProps('auswirkungEur', fe, { prefix: id })}
              />
            </Feld>
          </div>
        </>
      )}
    />
  );
}

export function MassnahmeDialog({
  action,
  sperre,
  personen,
  heute,
  vorschlagFrist,
}: {
  action: TcmsFormAktion;
  sperre: string | null;
  /** Wert `KANZLEI:<id>` bzw. `MANDANT:<id>`, Name aus der kanzleikonsole. */
  personen: ReadonlyArray<readonly [string, string]>;
  heute: string;
  vorschlagFrist: string;
}) {
  return (
    <DialogFormular
      ausloeser="+ Maßnahme"
      titel="Maßnahme anlegen"
      hinweis="Die Wiedervorlage-Nummer wird kanzleiweit fortlaufend vergeben."
      action={action}
      bestaetigen="Anlegen"
      disabled={sperre !== null}
      disabledGrund={sperre}
      felder={(fe, id) => (
        <>
          <Feld id={id} name="beschreibung" label="Maßnahme" fe={fe}>
            <input
              id={`${id}-beschreibung`}
              name="beschreibung"
              className="input"
              required
              minLength={5}
              maxLength={500}
              placeholder="z. B. Registrierung in CZ beauftragen"
              {...fieldErrorProps('beschreibung', fe, { prefix: id })}
            />
          </Feld>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Feld id={id} name="verantwortlich" label="Verantwortlich" fe={fe}>
                <select
                  id={`${id}-verantwortlich`}
                  name="verantwortlich"
                  className="input"
                  defaultValue=""
                  required
                  {...fieldErrorProps('verantwortlich', fe, { prefix: id })}
                >
                  <Auswahl werte={personen} />
                </select>
              </Feld>
            </div>
            <Feld id={id} name="frist" label="Frist" fe={fe}>
              <input
                id={`${id}-frist`}
                name="frist"
                type="date"
                className="input"
                required
                min={heute}
                defaultValue={vorschlagFrist}
                {...fieldErrorProps('frist', fe, { prefix: id })}
              />
            </Feld>
          </div>
        </>
      )}
    />
  );
}

export function ErledigenDialog({
  action,
  nummer,
  beschreibung,
  sperre,
}: {
  action: TcmsFormAktion;
  nummer: number;
  beschreibung: string;
  sperre: string | null;
}) {
  return (
    <DialogFormular
      ausloeser={
        <>
          Erledigen …<span className="sr-only"> (Maßnahme #{nummer})</span>
        </>
      }
      titel={`Maßnahme #${nummer} erledigen`}
      hinweis={beschreibung}
      action={action}
      bestaetigen="Als erledigt dokumentieren"
      disabled={sperre !== null}
      disabledGrund={sperre}
      felder={(fe, id) => (
        <Feld
          id={id}
          name="nachweis"
          label={
            <>
              Nachweis der Umsetzung <span className="text-muted">(mindestens 10 Zeichen)</span>
            </>
          }
          fe={fe}
        >
          <textarea
            id={`${id}-nachweis`}
            name="nachweis"
            className="input"
            rows={3}
            required
            minLength={10}
            maxLength={2000}
            placeholder="Was wurde umgesetzt, wo liegt der Beleg?"
            {...fieldErrorProps('nachweis', fe, { prefix: id })}
          />
        </Feld>
      )}
    />
  );
}

export function NachkontrolleDialog({
  action,
  sperre,
  neu,
  kontrollen,
  vorschlag,
  vorschlagHinweis,
  heute,
  vorschlagFaellig,
}: {
  action: TcmsFormAktion;
  sperre: string | null;
  /** true: eine verknüpfte Nachkontrolle wird ersetzt. */
  neu: boolean;
  kontrollen: ReadonlyArray<readonly [string, string]>;
  vorschlag: string;
  vorschlagHinweis: string | null;
  heute: string;
  vorschlagFaellig: string;
}) {
  return (
    <DialogFormular
      ausloeser={neu ? 'Neue Nachkontrolle anlegen' : 'Nachkontrolle anlegen'}
      titel="Nachkontrolle anlegen"
      hinweis="Legt eine außerplanmäßige Durchführung der gewählten Kontrolle an und verknüpft sie mit der Feststellung."
      action={action}
      bestaetigen="Anlegen und verknüpfen"
      disabled={sperre !== null}
      disabledGrund={sperre}
      felder={(fe, id) => (
        <>
          <Feld id={id} name="kontrolleId" label="Kontrolle" fe={fe}>
            <select
              id={`${id}-kontrolleId`}
              name="kontrolleId"
              className="input"
              defaultValue={vorschlag}
              required
              {...fieldErrorProps('kontrolleId', fe, { prefix: id })}
            >
              <Auswahl werte={kontrollen} />
            </select>
            {vorschlagHinweis ? <p className="hint">{vorschlagHinweis}</p> : null}
          </Feld>
          <Feld id={id} name="faelligAm" label="Fällig am" fe={fe}>
            <input
              id={`${id}-faelligAm`}
              name="faelligAm"
              type="date"
              className="input w-auto"
              required
              min={heute}
              defaultValue={vorschlagFaellig}
              {...fieldErrorProps('faelligAm', fe, { prefix: id })}
            />
          </Feld>
        </>
      )}
    />
  );
}

/** Verwerfen beantragen (Begründung ≥ 30 Zeichen, Gefahrendialog). */
export function VerwerfenDialog({
  action,
  nummer,
  sperre,
}: {
  action: TcmsFormAktion;
  nummer: string;
  sperre: string | null;
}) {
  const [text, setText] = useState('');
  return (
    <DialogFormular
      ausloeser="Feststellung verwerfen …"
      ausloeserClass="btn-danger-outline text-xs py-1"
      titel={`${nummer} verwerfen`}
      hinweis="Nur mit Begründung; eine zweite Person bestätigt."
      action={action}
      bestaetigen="Verwerfen beantragen"
      gefahr
      disabled={sperre !== null}
      disabledGrund={sperre}
      absendenGesperrt={text.trim().length < 30}
      felder={(fe, id) => (
        <Feld
          id={id}
          name="begruendung"
          label={
            <>
              Begründung <span className="text-muted">(mindestens 30 Zeichen)</span>
            </>
          }
          fe={fe}
        >
          <textarea
            id={`${id}-begruendung`}
            name="begruendung"
            className="input"
            rows={4}
            required
            minLength={30}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            {...fieldErrorProps('begruendung', fe, { prefix: id })}
          />
          <div className="flex justify-between text-xs text-muted mt-1">
            <span>Wird von einer zweiten Person bestätigt.</span>
            <span className="font-mono">{text.trim().length}/30</span>
          </div>
        </Feld>
      )}
    />
  );
}

// ----------------------------------------------------------------------------
// §-153-Würdigung
// ----------------------------------------------------------------------------

export interface P153Option {
  wert: Paragraph153Entscheidung;
  titel: string;
  text: string;
}

export interface P153Ergebnis {
  label: string;
  begruendung: string | null;
  frist: string | null;
  beleg: string;
}

const P153_MIN = 30;

function P153Kopf({ id, offen }: { id: string; offen: boolean }) {
  return (
    <div className={`card-header ${offen ? 'alert-error rounded-none border-0' : ''}`}>
      <span className="inline-flex items-start gap-2">
        {offen ? (
          <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
        ) : (
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span>
          <h3 id={`${id}-titel`} className="text-sm font-semibold">
            {offen
              ? 'Würdigung durch Berufsträger erforderlich (höchstpersönlich)'
              : '§-153-Würdigung'}
          </h3>
          {offen ? (
            <span className="text-xs">
              Das Ergebnis ist nicht vorausgewählt. Strafrechtliche Bewertung ist nicht Teil des
              Moduls.
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="badge-gray">§ 153 AO</span>
        <span className="badge-yellow" title="Normanker ungeprüft">
          UNGEPRÜFT
        </span>
      </span>
    </div>
  );
}

function P153ErgebnisAnzeige({ ergebnis, offen }: { ergebnis: P153Ergebnis; offen: boolean }) {
  return (
    <div className={offen ? 'mb-4' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge-green">Entschieden: {ergebnis.label}</span>
        <span className="text-xs text-muted">{ergebnis.beleg}</span>
      </div>
      {ergebnis.begruendung ? (
        <p className="text-sm text-secondary mt-2 whitespace-pre-wrap">{ergebnis.begruendung}</p>
      ) : null}
      {ergebnis.frist ? <p className="text-xs text-muted mt-1">Frist: {ergebnis.frist}</p> : null}
      {offen ? (
        <p className="alert-info-sm mt-3">
          Die Entscheidung „weitere Klärung“ ist nicht abschließend. Nach der Klärung ist eine
          Folgeentscheidung zu dokumentieren.
        </p>
      ) : null}
    </div>
  );
}

/** Die vier Optionen gleichrangig, keine vorausgewählt. */
function P153Optionen({
  id,
  optionen,
  wahl,
  waehle,
  gesperrt,
  fe,
}: {
  id: string;
  optionen: readonly P153Option[];
  wahl: Paragraph153Entscheidung | null;
  waehle: (o: Paragraph153Entscheidung) => void;
  gesperrt: boolean;
  fe: FieldErrors | undefined;
}) {
  return (
    <>
      <div
        className="grid grid-cols-1 gap-3 md:grid-cols-2"
        {...fieldErrorProps('entscheidung', fe, { prefix: id })}
      >
        {optionen.map((o) => {
          const aktiv = wahl === o.wert;
          const option = `${id}-option-${o.wert}`;
          return (
            <div
              key={o.wert}
              className={`card flex items-start gap-2.5 p-3 shadow-none ${
                gesperrt ? 'cursor-not-allowed' : ''
              } ${aktiv ? 'border-brand-300 bg-brand-50' : ''}`}
            >
              <input
                id={option}
                type="radio"
                name="entscheidung"
                value={o.wert}
                checked={aktiv}
                onChange={() => waehle(o.wert)}
                className="mt-0.5"
                aria-describedby={`${option}-text`}
              />
              <span>
                <label htmlFor={option} className="block text-sm font-semibold text-primary">
                  {o.titel}
                </label>
                <span id={`${option}-text`} className="block text-xs text-muted mt-0.5">
                  {o.text}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <FieldError name="entscheidung" errors={fe?.entscheidung} prefix={id} />
    </>
  );
}

function P153Felder({
  id,
  text,
  setzeText,
  wahl,
  heute,
  fe,
}: {
  id: string;
  text: string;
  setzeText: (t: string) => void;
  wahl: Paragraph153Entscheidung | null;
  heute: string;
  fe: FieldErrors | undefined;
}) {
  const fristNoetig = wahl === 'BERICHTIGUNG' || wahl === 'WEITERE_KLAERUNG';
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      <div className="md:col-span-2">
        <label className="label-sm" htmlFor={`${id}-begruendung`}>
          Begründung <span className="text-muted">(mindestens {P153_MIN} Zeichen)</span>
        </label>
        <textarea
          id={`${id}-begruendung`}
          name="begruendung"
          className="input"
          rows={4}
          placeholder="Begründung der Entscheidung (Pflichtfeld)"
          value={text}
          onChange={(e) => setzeText(e.target.value)}
          minLength={P153_MIN}
          maxLength={4000}
          required
          {...fieldErrorProps('begruendung', fe, { prefix: id, describedBy: `${id}-zaehler` })}
        />
        <p id={`${id}-zaehler`} className="hint font-mono text-right" aria-live="polite">
          {text.trim().length}/{P153_MIN}
        </p>
        <FieldError name="begruendung" errors={fe?.begruendung} prefix={id} />
      </div>
      <div>
        <label className="label-sm" htmlFor={`${id}-frist`}>
          {wahl === 'WEITERE_KLAERUNG' ? 'Klärung bis' : 'Frist für Berichtigung'}
        </label>
        <input
          id={`${id}-frist`}
          type="date"
          name="frist"
          className="input"
          min={heute}
          required={fristNoetig}
          {...fieldErrorProps('frist', fe, { prefix: id, describedBy: `${id}-frist-hinweis` })}
        />
        <p id={`${id}-frist-hinweis`} className="hint">
          erforderlich bei „Berichtigung erforderlich“ und „Weitere Klärung“; erzeugt eine
          Wiedervorlage
        </p>
        <FieldError name="frist" errors={fe?.frist} prefix={id} />
      </div>
    </div>
  );
}

function absendenGrundP153(
  sperrGrund: string | null,
  wahl: Paragraph153Entscheidung | null,
  text: string,
): string | null {
  if (sperrGrund !== null) return sperrGrund;
  if (!wahl) return 'Bitte eine der vier Optionen wählen';
  if (text.trim().length < P153_MIN) return `Begründung mit mindestens ${P153_MIN} Zeichen`;
  return null;
}

export function P153Block({
  action,
  bisher,
  optionen,
  sperrGrund,
  sperrHinweis,
  ergebnis,
  offen,
  heute,
}: {
  action: TcmsFormAktion;
  /** Bisherige Entscheidung (nach „weitere Klärung“); der Dienst weist abweichende Stände ab. */
  bisher: Paragraph153Entscheidung | null;
  optionen: readonly P153Option[];
  /** null: Würdigung möglich; sonst Grund der sichtbaren Sperre. */
  sperrGrund: string | null;
  sperrHinweis: string | null;
  ergebnis: P153Ergebnis | null;
  /** true: Entscheidung (oder Folgeentscheidung nach „weitere Klärung“) steht aus. */
  offen: boolean;
  heute: string;
}) {
  const id = useId();
  const [wahl, setWahl] = useState<Paragraph153Entscheidung | null>(null);
  const [text, setText] = useState('');
  const [rueckmeldung, aktion] = useActionState<TcmsErgebnis | null, FormData>(action, null);
  const gesperrt = sperrGrund !== null;
  const fe = rueckmeldung && !rueckmeldung.ok ? rueckmeldung.fieldErrors : undefined;
  const absendenGrund = absendenGrundP153(sperrGrund, wahl, text);
  return (
    <section className={`card ${offen ? 'border-red-300' : ''}`} aria-labelledby={`${id}-titel`}>
      <P153Kopf id={id} offen={offen} />
      <div className="px-6 py-4">
        {ergebnis ? <P153ErgebnisAnzeige ergebnis={ergebnis} offen={offen} /> : null}
        {offen ? (
          <>
            {gesperrt && sperrHinweis ? (
              <div className="alert-warning mb-4 flex items-start gap-2.5">
                <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span>{sperrHinweis}</span>
              </div>
            ) : null}
            {rueckmeldung ? <Meldung ergebnis={rueckmeldung} titel="Nicht dokumentiert." /> : null}
            <form action={aktion} className="mt-2">
              <input type="hidden" name="bisher" value={bisher ?? ''} />
              <fieldset disabled={gesperrt} title={sperrGrund ?? undefined}>
                <legend className="sr-only">Ergebnis der §-153-Würdigung</legend>
                <P153Optionen
                  id={id}
                  optionen={optionen}
                  wahl={wahl}
                  waehle={setWahl}
                  gesperrt={gesperrt}
                  fe={fe}
                />
                <P153Felder
                  id={id}
                  text={text}
                  setzeText={setText}
                  wahl={wahl}
                  heute={heute}
                  fe={fe}
                />
                <div className="form-actions mt-3">
                  {absendenGrund ? (
                    <span className="text-xs text-muted">{absendenGrund}</span>
                  ) : null}
                  <Absenden disabled={absendenGrund !== null}>Entscheidung dokumentieren</Absenden>
                </div>
              </fieldset>
            </form>
          </>
        ) : null}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Vertraulich
// ----------------------------------------------------------------------------

/** Schalter „vertraulich“ (nur Berufsträger; gesperrt sichtbar mit Grund). */
export function VertraulichSchalter({
  action,
  wert,
  gesperrtGrund,
}: {
  action: TcmsFormAktion;
  wert: boolean;
  gesperrtGrund: string | null;
}) {
  const [ergebnis, aktion, laeuft] = useActionState<TcmsErgebnis | null, FormData>(action, null);
  return (
    <form action={aktion} className="space-y-2">
      <input type="hidden" name="vertraulich" value={wert ? '0' : '1'} />
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm">
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> vertraulich:{' '}
          <strong>{wert ? 'ja' : 'nein'}</strong>
        </span>
        <button
          type="submit"
          className="btn-secondary text-xs py-1"
          disabled={gesperrtGrund !== null || laeuft}
          aria-busy={laeuft}
          title={gesperrtGrund ?? 'Nur für Beteiligte sichtbar'}
        >
          {wert ? 'Vertraulichkeit aufheben' : 'Vertraulich markieren'}
        </button>
      </div>
      {gesperrtGrund ? <p className="hint">{gesperrtGrund}</p> : null}
      <Meldung ergebnis={ergebnis} />
    </form>
  );
}
