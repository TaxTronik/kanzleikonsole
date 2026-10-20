'use client';

// =============================================================================
// Formulare der Kontrolldurchführung und der Feststellungen (TCMS Stufe 3,
// Bereich C; portiert aus der Demo components/durchfuehrung/formulare.tsx und
// components/ui/client.tsx). Die Aktionen sind Server Actions mit gebundenem
// Mandanten (und Objekt); Formulare tragen nur Eingaben, nie Personen- oder
// Mandantenangaben. Destruktive Schritte fragen über den Gefahrendialog der
// kanzleikonsole nach (`bestaetigung` des Formular-Bausteins), Dialoge nutzen
// `Modal` (Fokusfalle, Esc, Fokus-Rückgabe). Rechte zeigt die Seite aus der
// Antwort des Dienstes an; entscheidend bleibt der Dienst. Abgesendet wird über
// den gemeinsamen Baustein `useTcmsFormular` (components/tcms/formular.ts):
// Eingaben bleiben bei einer Ablehnung stehen (Integration TCMS Stufe 3).
// =============================================================================

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Save, Send, Trash2, Upload, UserCheck } from 'lucide-react';
import { AUSWIRKUNG_LABEL, FESTSTELLUNG_KLASSE_LABEL, KLASSE_LABEL } from '@taxtronik/tcms-domain';
import { FieldError, fieldErrorProps, FormErrorSummary } from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import type { TcmsAktionsErgebnis, TcmsFormAktion } from '../ergebnis';
import { useTcmsFormular, type TcmsBestaetigung } from '../formular';
import { fmtGroesse } from './werte';
import { TCMS_TEXT_ISOLIERT, TcmsText } from '@/components/tcms/text';

/** Ergebnis einer TCMS-Aktion: feste Meldung bei Erfolg, sonst Fehler der Abbildung. */
export type TcmsErgebnis = TcmsAktionsErgebnis;
export type { TcmsFormAktion } from '../ergebnis';

/** Rückfrage vor dem Absenden (Gefahrendialog bei `gefahr`). */
export type Rueckfrage = TcmsBestaetigung;

function Versteckt({ felder }: { felder?: Readonly<Record<string, string>> | undefined }) {
  return (
    <>
      {Object.entries(felder ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

/** Ergebnis als Meldung (Fehler mit Feldfehlern bzw. feste Erfolgsmeldung). */
export function Meldung({
  ergebnis,
  titel = 'Nicht ausgeführt.',
}: {
  ergebnis: TcmsErgebnis | null;
  titel?: string;
}) {
  if (!ergebnis) return null;
  if (!ergebnis.ok) {
    return (
      <FormErrorSummary
        title={titel}
        {...(ergebnis.error ? { error: ergebnis.error } : {})}
        {...(ergebnis.fieldErrors ? { fieldErrors: ergebnis.fieldErrors } : {})}
      />
    );
  }
  return ergebnis.meldung ? (
    <p className="alert-success-sm" role="status">
      {ergebnis.meldung}
    </p>
  ) : null;
}

function Absenden({
  children,
  className = 'btn-primary',
  disabled,
  title,
  laeuftText = 'Bitte warten …',
  laeuft = false,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean | undefined;
  title?: string | undefined;
  laeuftText?: string;
  /** Übermittlung läuft (useTcmsFormular; useFormStatus sieht Transitionen nicht). */
  laeuft?: boolean;
}) {
  const pending = useFormStatus().pending || laeuft;
  return (
    <button
      type="submit"
      className={`${className} inline-flex items-center gap-1.5`}
      disabled={disabled || pending}
      aria-busy={pending}
      title={title}
    >
      {pending ? laeuftText : children}
    </button>
  );
}

// ----------------------------------------------------------------------------
// Einzelne Handlung als Knopf (Beginnen, Freigeben, Gegenzeichnen …)
// ----------------------------------------------------------------------------

export function AktionsKnopf({
  action,
  felder,
  children,
  className = 'btn-primary',
  disabled,
  title,
  rueckfrage,
}: {
  action: TcmsFormAktion;
  felder?: Readonly<Record<string, string>>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Grund einer Sperre (aus `rechte.*.grund`) bzw. Erläuterung. */
  title?: string | undefined;
  rueckfrage?: Rueckfrage;
}) {
  const { ergebnis, laeuft, formular } = useTcmsFormular(action, {
    zuruecksetzen: false,
    ...(rueckfrage ? { bestaetigung: rueckfrage } : {}),
  });
  return (
    <form {...formular} className="flex flex-col items-end gap-1.5">
      <Versteckt felder={felder} />
      <Absenden className={className} disabled={disabled} title={title} laeuft={laeuft}>
        {children}
      </Absenden>
      {disabled && title ? <span className="sr-only">{title}</span> : null}
      {ergebnis ? (
        <div className="max-w-md">
          <Meldung ergebnis={ergebnis} />
        </div>
      ) : null}
    </form>
  );
}

// ----------------------------------------------------------------------------
// Begründungsdialog (Zurückweisen, Entfallen, Nachtrag, Verwerfen …)
// ----------------------------------------------------------------------------

export function BegruendungsDialog({
  ausloeser,
  ausloeserClass = 'btn-secondary',
  titel,
  hinweis,
  action,
  felder,
  bestaetigen = 'Absenden',
  min = 30,
  vierAugen = true,
  gefahr = false,
  disabled,
  disabledGrund,
  children,
}: {
  ausloeser: ReactNode;
  ausloeserClass?: string;
  titel: string;
  hinweis?: string;
  action: TcmsFormAktion;
  felder?: Readonly<Record<string, string>>;
  bestaetigen?: string;
  min?: number;
  vierAugen?: boolean;
  gefahr?: boolean;
  disabled?: boolean;
  disabledGrund?: string | undefined;
  children?: ReactNode;
}) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`${ausloeserClass} inline-flex items-center gap-1.5`}
        onClick={() => setOffen(true)}
        disabled={disabled}
        title={disabled ? disabledGrund : undefined}
      >
        {ausloeser}
      </button>
      {offen ? (
        <BegruendungsInhalt
          titel={titel}
          {...(hinweis ? { hinweis } : {})}
          action={action}
          {...(felder ? { felder } : {})}
          bestaetigen={bestaetigen}
          min={min}
          vierAugen={vierAugen}
          gefahr={gefahr}
          schliessen={() => setOffen(false)}
        >
          {children}
        </BegruendungsInhalt>
      ) : null}
    </>
  );
}

function BegruendungsInhalt({
  titel,
  hinweis,
  action,
  felder,
  bestaetigen,
  min,
  vierAugen,
  gefahr,
  schliessen,
  children,
}: {
  titel: string;
  hinweis?: string;
  action: TcmsFormAktion;
  felder?: Readonly<Record<string, string>>;
  bestaetigen: string;
  min: number;
  vierAugen: boolean;
  gefahr: boolean;
  schliessen: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const { ergebnis, laeuft, formular } = useTcmsFormular(action, { zuruecksetzen: false });
  useEffect(() => {
    if (ergebnis?.ok) schliessen();
  }, [ergebnis, schliessen]);
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <Modal title={titel} onClose={schliessen} maxWidth="max-w-lg">
      <h2 className="text-base font-semibold text-primary pr-8">{titel}</h2>
      {hinweis ? <p className="text-xs text-muted mt-1">{hinweis}</p> : null}
      <form {...formular} className="mt-4 space-y-3">
        <Versteckt felder={felder} />
        {ergebnis && !ergebnis.ok ? <Meldung ergebnis={ergebnis} /> : null}
        {children}
        <div>
          <label className="label" htmlFor={`${id}-begruendung`}>
            Begründung <span className="text-muted text-xs">(mindestens {min} Zeichen)</span>
          </label>
          <textarea
            {...TCMS_TEXT_ISOLIERT}
            id={`${id}-begruendung`}
            name="begruendung"
            className="input"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            minLength={min}
            maxLength={4000}
            autoFocus
            {...fieldErrorProps('begruendung', fieldErrors, {
              prefix: id,
              describedBy: `${id}-zaehler`,
            })}
          />
          <FieldError name="begruendung" errors={fieldErrors?.begruendung} prefix={id} />
          <div className="flex justify-between text-xs text-muted mt-1">
            <span>
              {vierAugen
                ? 'Wird von einer zweiten Person bestätigt.'
                : 'Wird mit Name und Zeitpunkt protokolliert.'}
            </span>
            <span id={`${id}-zaehler`} className="font-mono" aria-live="polite">
              {text.trim().length}/{min}
            </span>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={schliessen}>
            Abbrechen
          </button>
          <Absenden
            className={gefahr ? 'btn-danger-outline' : 'btn-primary'}
            disabled={text.trim().length < min}
            laeuft={laeuft}
          >
            {bestaetigen}
          </Absenden>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------
// Fußleiste mit „Entwurf speichern“ / „Einreichen“. Die Eingaben (Schritte,
// Werte, Ergebnis) gehören über das form-Attribut zu diesem Formular.
// ----------------------------------------------------------------------------

export function EntwurfFormular({
  action,
  formId,
  einreichen,
  links,
}: {
  action: TcmsFormAktion;
  formId: string;
  einreichen: string;
  links?: ReactNode;
}) {
  // Schritte, Kommentare und Werte gehören über `form` zu diesem Formular: ohne
  // Reset, damit eine abgewiesene Einreichung keine Eingaben verwirft.
  const { ergebnis, laeuft, formular } = useTcmsFormular(action, { zuruecksetzen: false });
  return (
    <div className="flex flex-col gap-2">
      <Meldung ergebnis={ergebnis} titel="Nicht gespeichert bzw. nicht eingereicht." />
      <div className="form-actions flex-wrap">
        {links}
        <form id={formId} {...formular} className="flex items-center gap-2">
          <button
            type="submit"
            name="absicht"
            value="speichern"
            className="btn-secondary inline-flex items-center gap-1.5"
            disabled={laeuft}
            aria-busy={laeuft}
          >
            <Save className="h-4 w-4" aria-hidden="true" /> Entwurf speichern
          </button>
          <button
            type="submit"
            name="absicht"
            value="einreichen"
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={laeuft}
            aria-busy={laeuft}
          >
            <Send className="h-4 w-4" aria-hidden="true" /> {einreichen}
          </button>
        </form>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Gegenzeichnen mit Befund: Inline-Erfassung der Feststellung
// ----------------------------------------------------------------------------

const FELD_BEFUND = {
  titel: 'fTitel',
  sachverhalt: 'fSachverhalt',
  klasse: 'fKlasse',
  schwere: 'fSchwere',
  auswirkung: 'fAuswirkung',
  risikoIds: 'fRisiko',
} as const;

export function GegenzeichnenMitBefundDialog({
  action,
  disabled,
  title,
  risiken,
  vorschlagSachverhalt,
  vorschlagTitel,
}: {
  action: TcmsFormAktion;
  disabled?: boolean;
  title?: string | undefined;
  risiken: ReadonlyArray<{ id: string; code: string; titel: string }>;
  vorschlagSachverhalt: string;
  vorschlagTitel: string;
}) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn-primary inline-flex items-center gap-1.5"
        disabled={disabled}
        title={title}
        onClick={() => setOffen(true)}
      >
        <UserCheck className="h-4 w-4" aria-hidden="true" /> Gegenzeichnen …
      </button>
      {offen ? (
        <BefundDialog
          action={action}
          risiken={risiken}
          vorschlagSachverhalt={vorschlagSachverhalt}
          vorschlagTitel={vorschlagTitel}
          schliessen={() => setOffen(false)}
        />
      ) : null}
    </>
  );
}

function BefundDialog({
  action,
  risiken,
  vorschlagSachverhalt,
  vorschlagTitel,
  schliessen,
}: {
  action: TcmsFormAktion;
  risiken: ReadonlyArray<{ id: string; code: string; titel: string }>;
  vorschlagSachverhalt: string;
  vorschlagTitel: string;
  schliessen: () => void;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(action, { zuruecksetzen: false });
  useEffect(() => {
    if (ergebnis?.ok) schliessen();
  }, [ergebnis, schliessen]);
  const fe = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  const feld = (name: string) => fieldErrorProps(name, fe, { prefix: id });
  const titel = 'Gegenzeichnen – abgeschlossen mit Befund';
  return (
    <Modal title={titel} onClose={schliessen} maxWidth="max-w-2xl">
      <h2 className="text-base font-semibold text-primary pr-8">{titel}</h2>
      <p className="text-xs text-muted mt-1">
        Die durchführende Person hat einen Befund angegeben. Mit der Gegenzeichnung wird die
        verknüpfte Feststellung erfasst (Status „Erfasst“).
      </p>
      <form {...formular} className="mt-4 space-y-3">
        {ergebnis && !ergebnis.ok ? <Meldung ergebnis={ergebnis} /> : null}
        <div>
          <label className="label" htmlFor={`${id}-titel`}>
            Titel der Feststellung
          </label>
          <input
            id={`${id}-titel`}
            name={FELD_BEFUND.titel}
            className="input"
            required
            minLength={5}
            maxLength={200}
            defaultValue={vorschlagTitel}
            {...feld(FELD_BEFUND.titel)}
          />
          <FieldError name={FELD_BEFUND.titel} errors={fe?.[FELD_BEFUND.titel]} prefix={id} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-sachverhalt`}>
            Sachverhalt <span className="text-muted text-xs">(mindestens 20 Zeichen)</span>
          </label>
          <textarea
            {...TCMS_TEXT_ISOLIERT}
            id={`${id}-sachverhalt`}
            name={FELD_BEFUND.sachverhalt}
            className="input"
            rows={4}
            required
            minLength={20}
            maxLength={4000}
            defaultValue={vorschlagSachverhalt}
            {...feld(FELD_BEFUND.sachverhalt)}
          />
          <FieldError
            name={FELD_BEFUND.sachverhalt}
            errors={fe?.[FELD_BEFUND.sachverhalt]}
            prefix={id}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`${id}-klasse`}>
              Klasse
            </label>
            <select
              id={`${id}-klasse`}
              name={FELD_BEFUND.klasse}
              className="input"
              required
              defaultValue=""
              {...feld(FELD_BEFUND.klasse)}
            >
              <option value="" disabled>
                bitte wählen
              </option>
              {Object.entries(FESTSTELLUNG_KLASSE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <FieldError name={FELD_BEFUND.klasse} errors={fe?.[FELD_BEFUND.klasse]} prefix={id} />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-schwere`}>
              Schwere
            </label>
            <select
              id={`${id}-schwere`}
              name={FELD_BEFUND.schwere}
              className="input"
              required
              defaultValue=""
              {...feld(FELD_BEFUND.schwere)}
            >
              <option value="" disabled>
                bitte wählen
              </option>
              {Object.entries(KLASSE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <FieldError name={FELD_BEFUND.schwere} errors={fe?.[FELD_BEFUND.schwere]} prefix={id} />
          </div>
        </div>
        <fieldset {...feld(FELD_BEFUND.auswirkung)}>
          <legend className="label">Steuerliche Auswirkung</legend>
          <div className="flex flex-wrap gap-4">
            {Object.entries(AUSWIRKUNG_LABEL).map(([k, v]) => (
              <label key={k} className="inline-flex items-center gap-1.5 text-sm">
                <input type="radio" name={FELD_BEFUND.auswirkung} value={k} required /> {v}
              </label>
            ))}
          </div>
          <p className="hint">
            Bei „ja“ oder „unklar“ startet der §-153-Pfad; die Würdigung trifft ausschließlich ein
            Berufsträger.
          </p>
          <FieldError
            name={FELD_BEFUND.auswirkung}
            errors={fe?.[FELD_BEFUND.auswirkung]}
            prefix={id}
          />
        </fieldset>
        <fieldset {...feld(FELD_BEFUND.risikoIds)}>
          <legend className="label">Betroffene Risiken</legend>
          <div className="flex flex-col gap-1">
            {risiken.map((r) => (
              <label key={r.id} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name={FELD_BEFUND.risikoIds} value={r.id} defaultChecked />
                <span className="font-mono text-xs">{r.code}</span>
                <span className="text-secondary">
                  <TcmsText>{r.titel}</TcmsText>
                </span>
              </label>
            ))}
          </div>
          <FieldError
            name={FELD_BEFUND.risikoIds}
            errors={fe?.[FELD_BEFUND.risikoIds]}
            prefix={id}
          />
        </fieldset>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={schliessen}>
            Abbrechen
          </button>
          <Absenden laeuft={laeuft}>Gegenzeichnen und Feststellung erfassen</Absenden>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------------------
// Nachweise: entfernen, hochladen, vorhandenes Dokument wählen
// ----------------------------------------------------------------------------

export function NachweisEntfernenKnopf({
  action,
  nachweisId,
  dateiname,
}: {
  action: TcmsFormAktion;
  nachweisId: string;
  dateiname: string;
}) {
  const { ergebnis, laeuft, formular } = useTcmsFormular(action, {
    zuruecksetzen: false,
    bestaetigung: {
      text: `„${dateiname}“ als Nachweis entfernen? Das Dokument bleibt in der Dokumentablage des Mandanten.`,
      titel: 'Nachweis entfernen',
      bestaetigen: 'Entfernen',
      gefahr: true,
    },
  });
  return (
    <form {...formular} className="flex flex-col items-end gap-1">
      <input type="hidden" name="nachweisId" value={nachweisId} />
      <Absenden
        className="btn-secondary text-xs py-1"
        title="Ungesperrten Nachweis entfernen"
        laeuft={laeuft}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Entfernen
        <span className="sr-only">
          {' '}
          (<TcmsText>{dateiname}</TcmsText>)
        </span>
      </Absenden>
      {ergebnis && !ergebnis.ok ? (
        <p className="text-xs text-red-700" role="alert">
          {ergebnis.error}
        </p>
      ) : null}
    </form>
  );
}

export function NachweisHochladen({
  action,
  maxBytes,
  maxText,
}: {
  action: TcmsFormAktion;
  maxBytes: number;
  maxText: string;
}) {
  const id = useId();
  // Zurückgesetzt wird nur nach Erfolg; bei Ablehnung bleibt die Datei gewählt.
  const { ergebnis, laeuft, formular } = useTcmsFormular(action);
  // Auswahl gehört zu dem Ergebnis, das bei der Auswahl galt; nach einem
  // Erfolg ist sie verbraucht (kein setState im Effekt).
  const [auswahl, setAuswahl] = useState<{
    name: string;
    groesse: number;
    fuer: TcmsErgebnis | null;
  } | null>(null);
  const datei = auswahl && !(ergebnis?.ok && auswahl.fuer !== ergebnis) ? auswahl : null;
  const zuGross = datei !== null && datei.groesse > maxBytes;
  const fe = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form {...formular} className="space-y-2" aria-label="Nachweis hochladen">
      <div>
        <label htmlFor={`${id}-datei`} className="label-sm">
          Datei hochladen
        </label>
        <input
          id={`${id}-datei`}
          type="file"
          name="datei"
          required
          className="block w-full text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setAuswahl(f ? { name: f.name, groesse: f.size, fuer: ergebnis } : null);
          }}
          {...fieldErrorProps('datei', fe, { prefix: id, describedBy: `${id}-hinweis` })}
        />
        <FieldError name="datei" errors={fe?.datei} prefix={id} />
        <p id={`${id}-hinweis`} className="hint">
          Bis {maxText}. Die Datei wird in der Dokumentablage des Mandanten gespeichert (Virenscan,
          SHA-256); das Tax-CMS erhält nur den Verweis. Beim Einreichen werden die Nachweise
          gesperrt.
        </p>
      </div>
      {datei ? (
        <p className="text-xs text-secondary">
          <TcmsText>{datei.name}</TcmsText> ({fmtGroesse(datei.groesse)})
        </p>
      ) : null}
      {zuGross ? (
        <p className="alert-error-sm" role="alert">
          Die Datei ist zu groß (max. {maxText}).
        </p>
      ) : (
        <Meldung ergebnis={ergebnis} titel="Nachweis nicht hochgeladen." />
      )}
      <Absenden
        className="btn-primary"
        disabled={zuGross}
        laeuftText="Wird hochgeladen …"
        laeuft={laeuft}
      >
        <Upload className="h-4 w-4" aria-hidden="true" /> Hochladen
      </Absenden>
    </form>
  );
}

export interface DokumentWahl {
  id: string;
  titel: string;
  groesse: number;
  erstellt: string;
}

export function NachweisAuswahl({
  action,
  dokumente,
}: {
  action: TcmsFormAktion;
  dokumente: readonly DokumentWahl[];
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(action);
  const fe = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  if (dokumente.length === 0) {
    return (
      <p className="text-xs text-muted">
        Keine weiteren gescannten Dokumente dieses Mandanten zur Auswahl.
      </p>
    );
  }
  return (
    <form {...formular} className="space-y-2" aria-label="Vorhandenes Dokument als Nachweis">
      <div>
        <label htmlFor={`${id}-dokument`} className="label-sm">
          Vorhandenes Dokument des Mandanten
        </label>
        <select
          id={`${id}-dokument`}
          name="dokumentId"
          className="input"
          required
          defaultValue=""
          {...fieldErrorProps('dokumentId', fe, { prefix: id })}
        >
          <option value="" disabled>
            bitte wählen
          </option>
          {dokumente.map((d) => (
            <option {...TCMS_TEXT_ISOLIERT} key={d.id} value={d.id}>
              {d.titel} · {fmtGroesse(d.groesse)} · {d.erstellt}
            </option>
          ))}
        </select>
        <FieldError name="dokumentId" errors={fe?.dokumentId} prefix={id} />
      </div>
      <Meldung ergebnis={ergebnis} titel="Nachweis nicht angehängt." />
      <Absenden className="btn-secondary" laeuft={laeuft}>
        Als Nachweis anhängen
      </Absenden>
    </form>
  );
}
