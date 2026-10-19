'use client';

// =============================================================================
// Aktion mit Bestätigungsdialog (TCMS Stufe 3, Bereich A): für Schritte mit
// Folgen, die sich nicht still zurücknehmen lassen – Freigabe beim Mandanten
// anfordern (Inhalt wird eingefroren), Review zurückweisen (mit Begründung),
// Freigabe neu adressieren (Code verfällt). Erst die ausdrückliche Bestätigung
// im Dialog ruft die Server-Action; eine Ablehnung bleibt im Dialog sichtbar,
// die Eingaben bleiben stehen. Dialog-A11y über `Modal` (Fokus-Falle, Esc,
// Fokus-Rückgabe an den Auslöser).
// =============================================================================

import { useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { FormErrorSummary } from '@/components/form-errors';
import { Modal } from '@/components/ui/modal';
import type { TcmsAktionsErgebnis, TcmsFormAktion } from '../ergebnis';

/** Ergebnis einer TCMS-Aktion; `meldung` ist ein fester Erfolgstext der Aktion (nie Text des Dienstes). */
export type { TcmsAktionsErgebnis } from '../ergebnis';

export type TcmsDialogAktion = TcmsFormAktion;

export function TcmsAktionsDialog({
  ausloeser,
  ausloeserKlasse = 'btn-secondary',
  titel,
  beschreibung,
  bestaetigen,
  laeuft = 'Wird übertragen …',
  gefahr = false,
  aktion,
  versteckt = {},
  children,
  erfolg,
  deaktiviert = false,
  deaktiviertGrund,
  fieldIds,
}: {
  ausloeser: ReactNode;
  ausloeserKlasse?: string;
  titel: string;
  beschreibung: ReactNode;
  bestaetigen: string;
  laeuft?: string;
  /** Roter Bestätigungsknopf (Gefahrendialog). */
  gefahr?: boolean;
  aktion: TcmsDialogAktion;
  /** Feste Formularwerte (z. B. Versions- oder Freigabe-ID). */
  versteckt?: Readonly<Record<string, string>>;
  /** Eingabefelder im Dialog (mit eigenen Labels). */
  children?: ReactNode;
  /** Meldung nach Erfolg (role="status" neben dem Auslöser), sofern die Aktion keine liefert. */
  erfolg: string;
  deaktiviert?: boolean;
  /** Sichtbarer Grund, warum die Aktion nicht angeboten wird. */
  deaktiviertGrund?: string;
  fieldIds?: Record<string, string>;
}) {
  const [offen, setOffen] = useState(false);
  const [ergebnis, setErgebnis] = useState<TcmsAktionsErgebnis | null>(null);
  const [gemeldet, setGemeldet] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const laufend = useRef(false);
  const grundId = useId();
  const beschreibungId = useId();

  function absenden(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (laufend.current) return;
    const formData = new FormData(event.currentTarget);
    laufend.current = true;
    start(async () => {
      try {
        const r = await aktion(null, formData);
        if (r.ok) {
          setErgebnis(null);
          setGemeldet(r.meldung ?? erfolg);
          setOffen(false);
        } else {
          setErgebnis(r);
        }
      } finally {
        laufend.current = false;
      }
    });
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className={ausloeserKlasse}
        disabled={deaktiviert}
        aria-describedby={deaktiviert && deaktiviertGrund ? grundId : undefined}
        onClick={() => {
          setErgebnis(null);
          setGemeldet(null);
          setOffen(true);
        }}
      >
        {ausloeser}
      </button>
      {deaktiviert && deaktiviertGrund ? (
        <span id={grundId} className="text-xs text-muted max-w-xs">
          {deaktiviertGrund}
        </span>
      ) : null}
      {gemeldet ? (
        <p className="alert-success-sm" role="status">
          {gemeldet}
        </p>
      ) : null}
      {offen ? (
        <Modal
          title={titel}
          onClose={() => setOffen(false)}
          maxWidth="max-w-lg"
          closeDisabled={busy}
        >
          <form onSubmit={absenden} aria-describedby={beschreibungId} noValidate>
            <h2 className="text-base font-semibold text-primary mb-2 pr-8">{titel}</h2>
            <div id={beschreibungId} className="text-sm text-secondary mb-4 space-y-2">
              {beschreibung}
            </div>
            {Object.entries(versteckt).map(([name, wert]) => (
              <input key={name} type="hidden" name={name} value={wert} />
            ))}
            {ergebnis && !ergebnis.ok ? (
              <div className="mb-3">
                <FormErrorSummary
                  title="Das hat nicht geklappt."
                  {...(ergebnis.error ? { error: ergebnis.error } : {})}
                  {...(ergebnis.fieldErrors ? { fieldErrors: ergebnis.fieldErrors } : {})}
                  {...(fieldIds ? { fieldIds } : {})}
                />
              </div>
            ) : null}
            {children ? <div className="space-y-3 mb-4">{children}</div> : null}
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary flex-1"
                disabled={busy}
                onClick={() => setOffen(false)}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                className={`btn-primary flex-1 ${gefahr ? '!bg-red-600 hover:!bg-red-700' : ''}`}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? laeuft : bestaetigen}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
