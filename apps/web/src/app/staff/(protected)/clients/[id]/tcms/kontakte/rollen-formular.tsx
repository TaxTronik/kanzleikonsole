'use client';

// Rollen eines Kontakts im Tax-CMS (TCMS Stufe 3). Labels der Rollen aus
// der Seite (Domain, MANDANT_ROLLE_LABEL); Ergebnis als feste Meldung der
// Aktion. Absenden über useTcmsFormular: Eingaben bleiben bei einer Ablehnung
// stehen. Ohne Recht laut Dienst (`gesperrt`) bleibt das Formular sichtbar,
// alle Felder und der Knopf sind gesperrt und verweisen auf den Grund.
import { useId } from 'react';
import { FieldError, fieldErrorProps, FormErrorSummary } from '@/components/form-errors';
import { useTcmsFormular } from '@/components/tcms/formular';
import { kontaktRollenSetzenAction } from './actions';
import { TcmsText } from '@/components/tcms/text';

export interface RollenAuswahl {
  wert: string;
  label: string;
}

/** Sperre laut Dienst: fester Grund und ID des sichtbaren Hinweises der Seite. */
export interface RollenSperre {
  grund: string;
  hinweisId: string;
}

export function RollenFormular({
  mandantId,
  kontaktId,
  kontaktName,
  rollen,
  aktiveRollen,
  funktion,
  rollenZuweisbar,
  gesperrt = null,
}: {
  mandantId: string;
  kontaktId: string;
  kontaktName: string;
  rollen: readonly RollenAuswahl[];
  aktiveRollen: readonly string[];
  funktion: string | null;
  /** false bei inaktiven Kontakten: nur Entfernen möglich. */
  rollenZuweisbar: boolean;
  /** Kein Recht laut Dienst (`rechte.bearbeiten`): nichts änderbar. */
  gesperrt?: RollenSperre | null;
}) {
  const id = useId();
  const { ergebnis, laeuft, formular } = useTcmsFormular(
    kontaktRollenSetzenAction.bind(null, mandantId),
    { zuruecksetzen: false },
  );
  const fieldErrors = ergebnis && !ergebnis.ok ? ergebnis.fieldErrors : undefined;
  return (
    <form {...formular} className="space-y-2" aria-label={`Tax-CMS-Rollen von ${kontaktName}`}>
      <input type="hidden" name="kontaktId" value={kontaktId} />
      {ergebnis && !ergebnis.ok ? (
        <FormErrorSummary
          title="Rollen nicht gespeichert."
          {...(ergebnis.error ? { error: ergebnis.error } : {})}
          {...(fieldErrors ? { fieldErrors } : {})}
        />
      ) : null}
      {ergebnis?.ok ? (
        <p className="alert-success-sm" role="status">
          Rollen gespeichert.
        </p>
      ) : null}
      <fieldset
        disabled={gesperrt !== null}
        aria-describedby={gesperrt?.hinweisId}
        className="space-y-2"
      >
        <legend className="sr-only">Rollen von {kontaktName}</legend>
        <fieldset {...fieldErrorProps('rollen', fieldErrors, { prefix: id })}>
          <legend className="sr-only">Rollen</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {rollen.map((rolle) => (
              <label key={rolle.wert} className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  name="rollen"
                  value={rolle.wert}
                  defaultChecked={aktiveRollen.includes(rolle.wert)}
                  disabled={!rollenZuweisbar && !aktiveRollen.includes(rolle.wert)}
                />
                <TcmsText>{rolle.label}</TcmsText>
              </label>
            ))}
          </div>
          <FieldError name="rollen" errors={fieldErrors?.rollen} prefix={id} />
        </fieldset>
        <div>
          <label htmlFor={`${id}-funktion`} className="label-sm">
            Funktion (optional)
          </label>
          <input
            id={`${id}-funktion`}
            name="funktion"
            className="input"
            maxLength={200}
            defaultValue={funktion ?? ''}
            {...fieldErrorProps('funktion', fieldErrors, { prefix: id })}
          />
          <FieldError name="funktion" errors={fieldErrors?.funktion} prefix={id} />
        </div>
        <button
          type="submit"
          className="btn-secondary text-xs py-1"
          disabled={laeuft || gesperrt !== null}
          aria-busy={laeuft}
          title={gesperrt?.grund}
        >
          {laeuft ? 'Wird gespeichert …' : 'Rollen speichern'}
        </button>
      </fieldset>
    </form>
  );
}
