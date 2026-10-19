'use client';

// =============================================================================
// Freigabe mit Bestätigungscode und Kenntnisnahme im Portal (TCMS Stufe 3,
// Bereich D; aus der Demo components/portal/freigabe.tsx).
//
// Schutzregel Bestätigungscode: Der Code steht nur im Eingabefeld der Person,
// die ihn aus ihrer E-Mail abtippt. Er wird nie angezeigt, nie in einen
// React-Zustand übernommen (unkontrolliertes Feld) und unmittelbar nach dem
// Lesen der Formulardaten aus dem Feld gelöscht – auch bei einem falschen
// Code. Das Ergebnis der Aktion enthält ihn nicht (fester Text); Browser
// sollen ihn nicht speichern (autoComplete one-time-code, kein Verlauf).
// Fehlversuche und Sperre zählt das Tax-CMS.
// =============================================================================

import { useId } from 'react';
import { Check, CheckCheck } from 'lucide-react';
import { FieldError, fieldErrorProps } from '@/components/form-errors';
import { TcmsErgebnisMeldung } from '../ereignisse/aktionen';
import { useTcmsFormular, type TcmsFormAktion } from '../formular';

/** Name des Codefelds (auch für Tests der Schutzregel). */
export const CODE_FELD = 'code';

export function FreigabeCodeFormular({
  aktion,
  freigabeTitel,
}: {
  aktion: TcmsFormAktion;
  freigabeTitel: string;
}) {
  const id = useId();
  const { ergebnis, laeuft, onSubmit } = useTcmsFormular(aktion, {
    zuruecksetzen: false,
    // Code sofort nach dem Lesen aus dem Formular entfernen (nie stehen lassen).
    nachLesen: (form) => {
      const feld = form.elements.namedItem(CODE_FELD);
      if (feld instanceof HTMLInputElement) feld.value = '';
    },
  });
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-wrap items-end gap-3"
      aria-label={`${freigabeTitel} freigeben`}
      autoComplete="off"
    >
      <div>
        <label htmlFor={`${id}-code`} className="label-sm">
          Bestätigungscode (6 Ziffern)
        </label>
        <input
          id={`${id}-code`}
          name={CODE_FELD}
          className="input font-mono w-36 tracking-widest"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          required
          {...fieldErrorProps(CODE_FELD, fieldErrors, { prefix: id })}
        />
        <FieldError name={CODE_FELD} errors={fieldErrors?.[CODE_FELD]} prefix={id} />
      </div>
      <button type="submit" className="btn-primary" disabled={laeuft} aria-busy={laeuft}>
        <CheckCheck className="h-4 w-4" aria-hidden="true" />{' '}
        {laeuft ? 'Wird geprüft …' : 'Freigeben'}
      </button>
      <div className="w-full">
        <TcmsErgebnisMeldung ergebnis={ergebnis} titel="Nicht freigegeben." />
      </div>
    </form>
  );
}

export function KenntnisnahmeFormular({ aktion }: { aktion: TcmsFormAktion }) {
  const id = useId();
  const { ergebnis, laeuft, onSubmit } = useTcmsFormular(aktion, { zuruecksetzen: false });
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="gelesen"
            required
            className="mt-1"
            {...fieldErrorProps('gelesen', fieldErrors, { prefix: id })}
          />
          Ich habe das Dokument gelesen und nehme es zur Kenntnis.
        </label>
        <button type="submit" className="btn-secondary" disabled={laeuft} aria-busy={laeuft}>
          <Check className="h-4 w-4" aria-hidden="true" /> Zur Kenntnis genommen
        </button>
      </div>
      <FieldError name="gelesen" errors={fieldErrors?.['gelesen']} prefix={id} />
      <TcmsErgebnisMeldung ergebnis={ergebnis} titel="Nicht bestätigt." />
    </form>
  );
}
