'use client';

// =============================================================================
// Bedienelemente für Tax-CMS-Aktionen (TCMS Stufe 3, Bereich D; aus der Demo
// components/ui/client.tsx und components/feststellungen/dialog.tsx). Genutzt
// von Ereigniseingang (Kanzlei) und Portal (Aufgaben, Freigaben).
//
//   - TcmsAktionsKnopf: eine Handlung als Schaltfläche, optional mit
//     Bestätigungsdialog (`confirmDialog`, bei destruktiven Schritten als
//     Gefahrendialog).
//   - TcmsFormDialog: Dialog mit Feldern (Kinder aus der Server-Komponente),
//     optional mit Pflichtbegründung (Mindestlänge laut Vertrag).
//
// Gesperrte Elemente bleiben sichtbar und nennen den Grund als Text (nicht nur
// als Tooltip). Meldungen kommen ausschließlich aus dem ActionResult der Aktion
// (feste Texte aus server/tcms/zustand.ts bzw. der Aktion). Absenden über den
// gemeinsamen Formular-Baustein `useTcmsFormular` (components/tcms/formular.ts)
// ohne Reset, damit Eingaben bei einer Ablehnung erhalten bleiben.
// =============================================================================

import { useId, useState, type ReactNode } from 'react';
import { FormErrorSummary } from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import type { TcmsAktionsErgebnis, TcmsFormAktion } from '../ergebnis';
import { useTcmsFormular, type TcmsBestaetigung } from '../formular';

export type { TcmsAktionsErgebnis, TcmsFormAktion } from '../ergebnis';
export type { TcmsBestaetigung } from '../formular';

/** Fehler- bzw. Erfolgsmeldung eines Ergebnisses. */
export function TcmsErgebnisMeldung({
  ergebnis,
  erfolg,
  titel = 'Das hat nicht geklappt.',
}: {
  ergebnis: TcmsAktionsErgebnis | null;
  erfolg?: string;
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
  if (ergebnis.warnung) {
    return (
      <p className="alert-warning text-sm" role="status">
        {ergebnis.warnung}
      </p>
    );
  }
  const text = ergebnis.meldung ?? erfolg;
  return text ? (
    <p className="alert-success-sm" role="status">
      {text}
    </p>
  ) : null;
}

/** Hinweis zu einem gesperrten Bedienelement (sichtbar, per aria-describedby verbunden). */
function SperrHinweis({ id, grund }: { id: string; grund: string }) {
  return (
    <p id={id} className="text-xs text-muted mt-1">
      {grund}
    </p>
  );
}

/** Eine Handlung als Schaltfläche (Formular ohne Felder außer `felder`). */
export function TcmsAktionsKnopf({
  aktion,
  children,
  className = 'btn-secondary',
  gesperrt,
  bestaetigung,
  erfolg,
  felder,
}: {
  aktion: TcmsFormAktion;
  children: ReactNode;
  className?: string;
  /** Grund, warum die Handlung gesperrt ist (null/undefined: frei). */
  gesperrt?: string | null;
  bestaetigung?: TcmsBestaetigung;
  erfolg?: string;
  /** Versteckte Formularfelder (z. B. Auswahl); IDs gehören in gebundene Argumente. */
  felder?: Readonly<Record<string, string>>;
}) {
  const id = useId();
  const { ergebnis, laeuft, onSubmit } = useTcmsFormular(aktion, {
    zuruecksetzen: false,
    ...(bestaetigung ? { bestaetigung } : {}),
  });
  return (
    <form onSubmit={onSubmit} className="inline-flex flex-col items-start gap-1">
      {Object.entries(felder ?? {}).map(([name, wert]) => (
        <input key={name} type="hidden" name={name} value={wert} />
      ))}
      <button
        type="submit"
        className={className}
        disabled={!!gesperrt || laeuft}
        aria-busy={laeuft}
        aria-describedby={gesperrt ? `${id}-grund` : undefined}
      >
        {laeuft ? 'Bitte warten …' : children}
      </button>
      {gesperrt ? <SperrHinweis id={`${id}-grund`} grund={gesperrt} /> : null}
      <TcmsErgebnisMeldung ergebnis={ergebnis} {...(erfolg ? { erfolg } : {})} />
    </form>
  );
}

/**
 * Dialog mit Feldern. Die Felder kommen als Kinder (Server-Komponente); mit
 * `begruendung` zusätzlich ein Pflichtfeld „Begründung“ mit Mindestlänge.
 * Erfolg schließt den Dialog und zeigt die Meldung am Auslöser. Der Inhalt
 * wird je Öffnen neu aufgebaut (keine alten Meldungen, keine alten Eingaben).
 */
export function TcmsFormDialog({
  aktion,
  ausloeser,
  ausloeserKlasse = 'btn-secondary',
  titel,
  hinweis,
  bestaetigen,
  gefahr = false,
  begruendung,
  gesperrt,
  erfolg,
  breit = false,
  children,
}: {
  aktion: TcmsFormAktion;
  ausloeser: ReactNode;
  ausloeserKlasse?: string;
  titel: string;
  hinweis?: string;
  bestaetigen: string;
  gefahr?: boolean;
  begruendung?: { min: number; max: number; hinweis?: string };
  gesperrt?: string | null;
  erfolg?: string;
  breit?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const [offen, setOffen] = useState(false);
  const [erledigt, setErledigt] = useState<TcmsAktionsErgebnis | null>(null);
  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className={ausloeserKlasse}
        disabled={!!gesperrt}
        aria-describedby={gesperrt ? `${id}-grund` : undefined}
        onClick={() => {
          setErledigt(null);
          setOffen(true);
        }}
      >
        {ausloeser}
      </button>
      {gesperrt ? <SperrHinweis id={`${id}-grund`} grund={gesperrt} /> : null}
      {!offen && erledigt ? (
        <TcmsErgebnisMeldung ergebnis={erledigt} {...(erfolg ? { erfolg } : {})} />
      ) : null}
      {offen ? (
        <DialogInhalt
          aktion={aktion}
          titel={titel}
          bestaetigen={bestaetigen}
          gefahr={gefahr}
          breit={breit}
          schliessen={() => setOffen(false)}
          nachErfolg={(r) => {
            setErledigt(r);
            setOffen(false);
          }}
          {...(hinweis ? { hinweis } : {})}
          {...(begruendung ? { begruendung } : {})}
        >
          {children}
        </DialogInhalt>
      ) : null}
    </div>
  );
}

function DialogInhalt({
  aktion,
  titel,
  hinweis,
  bestaetigen,
  gefahr,
  begruendung,
  breit,
  schliessen,
  nachErfolg,
  children,
}: {
  aktion: TcmsFormAktion;
  titel: string;
  hinweis?: string;
  bestaetigen: string;
  gefahr: boolean;
  begruendung?: { min: number; max: number; hinweis?: string };
  breit: boolean;
  schliessen: () => void;
  nachErfolg: (ergebnis: TcmsAktionsErgebnis) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const { ergebnis, laeuft, onSubmit } = useTcmsFormular(
    async (vorher, formData) => {
      const r = await aktion(vorher, formData);
      if (r.ok) nachErfolg(r);
      return r;
    },
    { zuruecksetzen: false },
  );
  const zuKurz = begruendung ? text.trim().length < begruendung.min : false;
  return (
    <Modal
      title={titel}
      onClose={schliessen}
      maxWidth={breit ? 'max-w-2xl' : 'max-w-lg'}
      closeDisabled={laeuft}
    >
      <form onSubmit={onSubmit} className="space-y-4" aria-labelledby={`${id}-titel`}>
        <h2 id={`${id}-titel`} className="text-base font-semibold text-primary pr-8">
          {titel}
        </h2>
        {hinweis ? <p className="text-sm text-secondary">{hinweis}</p> : null}
        {ergebnis && !ergebnis.ok ? <TcmsErgebnisMeldung ergebnis={ergebnis} /> : null}
        {children}
        {begruendung ? (
          <div>
            <label htmlFor={`${id}-begruendung`} className="label-sm">
              Begründung
            </label>
            <textarea
              id={`${id}-begruendung`}
              name="begruendung"
              className="input min-h-[6rem]"
              required
              minLength={begruendung.min}
              maxLength={begruendung.max}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={`${id}-begruendung-hinweis`}
              aria-invalid={ergebnis?.fieldErrors?.['begruendung'] ? true : undefined}
            />
            <p id={`${id}-begruendung-hinweis`} className="hint">
              Mindestens {begruendung.min} Zeichen ({text.trim().length}/{begruendung.min}).
              {begruendung.hinweis ? ` ${begruendung.hinweis}` : ''}
            </p>
          </div>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={schliessen} disabled={laeuft}>
            Abbrechen
          </button>
          <button
            type="submit"
            className={gefahr ? 'btn-danger-outline' : 'btn-primary'}
            disabled={laeuft || zuKurz}
            aria-busy={laeuft}
          >
            {laeuft ? 'Bitte warten …' : bestaetigen}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Formular mit Feldern als Kinder (Server-Komponente) und einer Schaltfläche,
 * z. B. „Folgen anlegen“ mit mehreren Vorschlagszeilen. Kein Reset bei Fehlern.
 */
export function TcmsFormular({
  aktion,
  absenden,
  gesperrt,
  erfolg,
  titel,
  children,
}: {
  aktion: TcmsFormAktion;
  absenden: string;
  gesperrt?: string | null;
  erfolg?: string;
  /** Titel der Fehlerzusammenfassung. */
  titel?: string;
  children: ReactNode;
}) {
  const id = useId();
  const { ergebnis, laeuft, onSubmit } = useTcmsFormular(aktion, { zuruecksetzen: false });
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {children}
      <TcmsErgebnisMeldung
        ergebnis={ergebnis}
        {...(erfolg ? { erfolg } : {})}
        {...(titel ? { titel } : {})}
      />
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={!!gesperrt || laeuft}
          aria-busy={laeuft}
          aria-describedby={gesperrt ? `${id}-grund` : undefined}
        >
          {laeuft ? 'Bitte warten …' : absenden}
        </button>
      </div>
      {gesperrt ? <SperrHinweis id={`${id}-grund`} grund={gesperrt} /> : null}
    </form>
  );
}
