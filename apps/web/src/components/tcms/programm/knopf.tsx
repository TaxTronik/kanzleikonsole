'use client';

// =============================================================================
// Ein-Klick-Aktion des Tax-CMS (TCMS Stufe 3, Bereich A): Formular mit festen
// Werten und einem Knopf, z. B. „Zur Kanzlei-Review einreichen“, „Review
// abschließen“, „Neue Version anlegen“, „Risiko aufnehmen“. Fehler erscheinen
// unter dem Knopf (role="alert"), Erfolg als feste Meldung der Aktion
// (role="status"). Doppelklicks lösen keinen zweiten Aufruf aus.
// =============================================================================

import { useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import type { TcmsAktionsErgebnis, TcmsDialogAktion } from './dialog';

export function TcmsKnopfAktion({
  aktion,
  versteckt = {},
  children,
  knopfKlasse = 'btn-secondary',
  laeuft = 'Wird übertragen …',
  erfolg,
  deaktiviert = false,
  deaktiviertGrund,
  titel,
}: {
  aktion: TcmsDialogAktion;
  versteckt?: Readonly<Record<string, string>>;
  children: ReactNode;
  knopfKlasse?: string;
  laeuft?: string;
  /** Erfolgsmeldung, falls die Aktion keine `meldung` liefert. */
  erfolg: string;
  deaktiviert?: boolean;
  /** Sichtbarer Grund, warum die Aktion nicht angeboten wird. */
  deaktiviertGrund?: string;
  /** Zusätzliche Erklärung am Knopf (Tooltip und Beschreibung). */
  titel?: string;
}) {
  const [ergebnis, setErgebnis] = useState<TcmsAktionsErgebnis | null>(null);
  const [busy, start] = useTransition();
  const laufend = useRef(false);
  const grundId = useId();

  function absenden(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (laufend.current || deaktiviert) return;
    const formData = new FormData(event.currentTarget);
    laufend.current = true;
    start(async () => {
      try {
        setErgebnis(await aktion(null, formData));
      } finally {
        laufend.current = false;
      }
    });
  }

  const beschreibung = deaktiviert ? (deaktiviertGrund ?? titel) : titel;
  return (
    <form onSubmit={absenden} className="inline-flex flex-col items-start gap-1">
      {Object.entries(versteckt).map(([name, wert]) => (
        <input key={name} type="hidden" name={name} value={wert} />
      ))}
      <button
        type="submit"
        className={knopfKlasse}
        disabled={deaktiviert || busy}
        aria-busy={busy}
        title={beschreibung}
        aria-describedby={beschreibung ? grundId : undefined}
      >
        {busy ? laeuft : children}
      </button>
      {beschreibung ? (
        <span id={grundId} className={deaktiviert ? 'text-xs text-muted max-w-xs' : 'sr-only'}>
          {beschreibung}
        </span>
      ) : null}
      {ergebnis && !ergebnis.ok ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400 max-w-sm">
          {ergebnis.error ?? 'Das hat nicht geklappt.'}
        </p>
      ) : null}
      {ergebnis?.ok ? (
        <p role="status" className="alert-success-sm">
          {ergebnis.meldung ?? erfolg}
        </p>
      ) : null}
    </form>
  );
}
