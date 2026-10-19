'use client';

// Auswahlformular des Risikoinventars (TCMS Stufe 3, Demo AktionsForm um die
// Tabelle): ausgewählte Risiken zur Freigabe einreichen oder – als zweite
// Person – freigeben. Welche Risiken bearbeitet oder übersprungen werden,
// entscheidet der Dienst; die Meldung nennt beides.
import type { ReactNode } from 'react';
import { CheckCheck, Send } from 'lucide-react';
import { FormErrorSummary } from '@/components/form-errors';
import type { TcmsAktion } from '../bereich-b/ergebnis';
import { useTcmsFormular } from '../formular';

export function FreigabeAuswahl({
  aktion,
  fuss,
  children,
}: {
  aktion: TcmsAktion;
  /** Text links im Fuß der Tabelle (Zählung, Modell). */
  fuss: ReactNode;
  children: ReactNode;
}) {
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion);
  return (
    <form {...formular} aria-label="Risiken zur Freigabe auswählen">
      {children}
      <div className="card-footer flex-wrap gap-2">
        <span>{fuss}</span>
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Auswahl:</span>
          <button
            type="submit"
            name="schritt"
            value="einreichen"
            className="btn-secondary text-xs py-1"
            disabled={laeuft}
            aria-busy={laeuft}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" /> Zur Freigabe einreichen
          </button>
          <button
            type="submit"
            name="schritt"
            value="freigeben"
            className="btn-primary text-xs py-1"
            disabled={laeuft}
            aria-busy={laeuft}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> Freigeben (zweite Person)
          </button>
        </span>
      </div>
      {ergebnis && !ergebnis.ok ? (
        <div className="px-6 pb-4">
          <FormErrorSummary
            title="Freigabeschritt nicht ausgeführt."
            {...(ergebnis.error ? { error: ergebnis.error } : {})}
            {...(ergebnis.fieldErrors ? { fieldErrors: ergebnis.fieldErrors } : {})}
          />
        </div>
      ) : null}
      {ergebnis?.ok ? (
        <p className="alert-success-sm mx-6 mb-4" role="status">
          {ergebnis.meldung}
        </p>
      ) : null}
    </form>
  );
}
