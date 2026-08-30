'use client';

import {
  DEFAULT_DISPLAY_OPTIONS,
  type AccessibleDisplayOptions,
  type DisplayOptionsPatch,
} from '@/lib/accessible-display-options';

export function AccessibleDisplayOptionsForm({
  id,
  options,
  pending,
  onSave,
}: {
  id: string;
  options: AccessibleDisplayOptions;
  pending: boolean;
  onSave: (patch: DisplayOptionsPatch) => void;
}) {
  return (
    <details className="mt-4 rounded-lg border border-default p-3">
      <summary className="cursor-pointer font-medium text-primary">
        Anzeige individuell anpassen
      </summary>
      <p id={`${id}-options-help`} className="mt-3 text-sm text-secondary">
        Diese Optionen gelten im aktivierten Anzeigemodus. Ihre Auswahl bleibt beim Ausschalten
        erhalten. Änderungen werden automatisch gespeichert. Die Bewegungsreduktion Ihres
        Betriebssystems hat immer Vorrang.
      </p>
      <fieldset
        aria-describedby={`${id}-options-help`}
        className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2"
      >
        <legend className="sr-only">Persönliche Anzeigeoptionen</legend>
        <div className="min-w-0">
          <label htmlFor={`${id}-font`} className="label">
            Schriftgröße
          </label>
          <select
            id={`${id}-font`}
            className="input w-full"
            value={options.fontSize}
            aria-disabled={pending}
            onChange={(event) =>
              onSave({
                fontSize: event.currentTarget.value as AccessibleDisplayOptions['fontSize'],
              })
            }
          >
            <option value="standard">Standard (100 %)</option>
            <option value="large">Groß (112,5 %)</option>
            <option value="extra-large">Sehr groß (125 %)</option>
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-spacing`} className="label">
            Zeilenabstand
          </label>
          <select
            id={`${id}-spacing`}
            className="input w-full"
            value={options.spacing}
            aria-disabled={pending}
            onChange={(event) =>
              onSave({ spacing: event.currentTarget.value as AccessibleDisplayOptions['spacing'] })
            }
          >
            <option value="normal">Normal (1,5-fach)</option>
            <option value="relaxed">Entspannt (1,6-fach)</option>
            <option value="wide">Weit (1,8-fach)</option>
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-contrast`} className="label">
            Kontrast
          </label>
          <select
            id={`${id}-contrast`}
            className="input w-full"
            value={options.contrast}
            aria-disabled={pending}
            onChange={(event) =>
              onSave({
                contrast: event.currentTarget.value as AccessibleDisplayOptions['contrast'],
              })
            }
          >
            <option value="standard">Standardkontrast der Ansicht</option>
            <option value="strong">Verstärkter Kontrast</option>
          </select>
        </div>
        <label className="flex min-h-11 items-center gap-3 font-medium text-primary">
          <input
            type="checkbox"
            checked={options.reduceMotion}
            aria-disabled={pending}
            onChange={(event) => onSave({ reduceMotion: event.currentTarget.checked })}
            className="h-5 w-5 shrink-0 rounded border-strong"
          />
          <span>Bewegung reduzieren</span>
        </label>
      </fieldset>
      <button
        type="button"
        className="btn-secondary mt-4"
        aria-disabled={pending}
        onClick={() => onSave({ ...DEFAULT_DISPLAY_OPTIONS })}
      >
        Empfohlene Anzeige wiederherstellen
      </button>
    </details>
  );
}
