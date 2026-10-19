'use client';

// Schaltfläche „Mandant im Tax-CMS anlegen“ bzw. „Stammdaten abgleichen“
// (TCMS Stufe 3). Kein Eingabefeld: die Daten kommen serverseitig aus der
// kanzleikonsole; die Antwort des Dienstes erscheint als feste Meldung.
import { useActionState } from 'react';
import { FormErrorSummary } from '@/components/form-errors';
import { mandantImTcmsAnlegenAction, type MandantAnkerErgebnis } from './actions';

export function MandantAnlegenFormular({
  mandantId,
  beschriftung,
  erfolg,
}: {
  mandantId: string;
  beschriftung: string;
  erfolg: string;
}) {
  const [ergebnis, aktion, laeuft] = useActionState<MandantAnkerErgebnis | null, FormData>(
    mandantImTcmsAnlegenAction.bind(null, mandantId),
    null,
  );
  return (
    <form action={aktion} className="space-y-3">
      {ergebnis && !ergebnis.ok ? (
        <FormErrorSummary
          title="Das hat nicht geklappt."
          {...(ergebnis.error ? { error: ergebnis.error } : {})}
          {...(ergebnis.fieldErrors ? { fieldErrors: ergebnis.fieldErrors } : {})}
        />
      ) : null}
      {ergebnis?.ok ? (
        <p className="alert-success-sm" role="status">
          {erfolg}
        </p>
      ) : null}
      <button type="submit" className="btn-primary" disabled={laeuft} aria-busy={laeuft}>
        {laeuft ? 'Wird übertragen …' : beschriftung}
      </button>
    </form>
  );
}
