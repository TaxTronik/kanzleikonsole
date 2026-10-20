'use client';

// =============================================================================
// Meldungen mit offenem Ausgang im Portal (kk-tcms-s10nach, TCMS s10): Die
// Seite listet die eigenen Meldevorgänge der angemeldeten Person (aus der
// kanzleikonsole, ohne Inhalt) und klärt sie beim Öffnen einmal automatisch
// sowie über „Jetzt erneut übermitteln“ – mit demselben Idempotenzschlüssel,
// es entsteht keine doppelte Meldung (server/tcms/portal/meldevorgang.ts).
// =============================================================================

import { useEffect, useId, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { isoZeitText } from '../format';
import { TcmsErgebnisMeldung } from '../ereignisse/aktionen';
import { useTcmsFormular, type TcmsFormAktion } from '../formular';

export interface OffeneMeldungAnzeige {
  id: string;
  /** ISO-Zeitpunkt des ersten Sendens; null = noch nicht gesendet. */
  gesendetAm: string | null;
  versuche: number;
  anlagen: number;
  faellig: boolean;
}

function zeile(v: OffeneMeldungAnzeige): string {
  const anlagen =
    v.anlagen === 0 ? 'ohne Anlagen' : v.anlagen === 1 ? '1 Anlage' : `${v.anlagen} Anlagen`;
  if (v.gesendetAm === null) return `Meldung wird vorbereitet · ${anlagen}`;
  const versuche = v.versuche > 0 ? ` · ${v.versuche + 1}. Versuch steht an` : '';
  return `Gesendet am ${isoZeitText(v.gesendetAm)}, Eingang noch nicht bestätigt · ${anlagen}${versuche}`;
}

export function OffeneMeldungen({
  vorgaenge,
  aktion,
}: {
  vorgaenge: readonly OffeneMeldungAnzeige[];
  aktion: TcmsFormAktion;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion, { zuruecksetzen: false });
  const automatisch = useRef(false);
  const faellig = vorgaenge.some((v) => v.faellig);
  const formularId = `${id}-formular`;

  // Beim Öffnen einmal automatisch klären (gleicher Weg wie der Knopf).
  useEffect(() => {
    if (!faellig || automatisch.current) return;
    automatisch.current = true;
    const form = document.getElementById(formularId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }, [faellig, formularId]);

  if (vorgaenge.length === 0 && !ergebnis) return null;
  return (
    <section className="card" aria-labelledby={`${id}-titel`}>
      <div className="card-header">
        <h2 id={`${id}-titel`} className="text-sm font-semibold text-primary">
          Meldungen in Übermittlung
        </h2>
        <span className="badge-yellow">{vorgaenge.length}</span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-secondary">
          Für diese Meldungen hat das Tax-CMS den Eingang noch nicht bestätigt. TaxTronik wiederholt
          die Übermittlung mit denselben Angaben; eine doppelte Meldung entsteht dabei nicht. Bitte
          melden Sie das Ereignis nicht erneut.
        </p>
        {vorgaenge.length ? (
          <ul className="text-sm space-y-1">
            {vorgaenge.map((v) => (
              <li key={v.id}>{zeile(v)}</li>
            ))}
          </ul>
        ) : null}
        <TcmsErgebnisMeldung ergebnis={ergebnis} titel="Die Übermittlung ist nicht gelungen." />
        <form {...formular} id={formularId} aria-label="Meldungen erneut übermitteln">
          <button
            type="submit"
            className="btn-secondary"
            disabled={laeuft || !faellig}
            aria-busy={laeuft}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />{' '}
            {laeuft ? 'Wird übermittelt …' : 'Jetzt erneut übermitteln'}
          </button>
        </form>
      </div>
    </section>
  );
}
