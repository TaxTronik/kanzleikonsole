'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { COMMON_COUNTRY_CODES, COUNTRIES, countryName } from '@/lib/countries';
import { MAX_UPLOAD_BYTES_BY_KIND, formatUploadLimit } from '@/lib/upload-limits.mjs';

// F-09: dieselbe Grenze wie die serverseitige Prüfung (binärer FormData-Upload).
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES_BY_KIND.gwgOnboardingFile;
export const MAX_UPLOAD_LABEL = formatUploadLimit(MAX_UPLOAD_BYTES);

/**
 * Rückfrage des Browsers beim Schließen, Neuladen oder Verlassen, solange
 * Eingaben nur in diesem Tab liegen. Browser zeigen sie erst nach einer
 * Interaktion mit der Seite und mit ihrem eigenen Text.
 */
export function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Ältere Browser zeigen die Rückfrage nur mit gesetztem returnValue.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}

const HIGHLIGHTED = 'border-emerald-600 ring-2 ring-emerald-500/40';

/** Beschriftung, Markierung „aus dem Ausweis übernommen“ und Eingabe. */
function Labeled({
  label,
  required,
  highlighted,
  children,
}: {
  label: string;
  required?: boolean;
  highlighted: boolean;
  children: (control: {
    id: string;
    className: string;
    'data-identity-applied'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
        {required && <span className="text-red-700 ml-1">*</span>}
      </label>
      {children({
        id,
        className: highlighted ? `input ${HIGHLIGHTED}` : 'input',
        'data-identity-applied': highlighted || undefined,
        'aria-describedby': highlighted ? `${id}-applied` : undefined,
      })}
      {highlighted && (
        <p id={`${id}-applied`} className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
          Aus dem Ausweis übernommen – bitte prüfen.
        </p>
      )}
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  placeholder,
  highlighted = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  /** Aus der Ausweishilfe übernommen und noch nicht bearbeitet. */
  highlighted?: boolean;
}) {
  return (
    <Labeled label={label} required={required} highlighted={highlighted}>
      {(control) => (
        <input
          {...control}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          placeholder={placeholder}
        />
      )}
    </Labeled>
  );
}

/** Länderoptionen: häufige zuerst, dann alle alphabetisch; Freitext aus älteren Angaben bleibt wählbar. */
function CountryOptions({ value, extra = [] }: { value: string; extra?: readonly string[] }) {
  const legacy = value && !countryName(value) && !extra.includes(value) ? value : null;
  return (
    <>
      <option value="" disabled>
        — bitte auswählen —
      </option>
      {legacy && <option value={legacy}>{legacy} (bisherige Angabe)</option>}
      <optgroup label="Häufig">
        {COMMON_COUNTRY_CODES.map((code) => (
          <option key={code} value={code}>
            {countryName(code)}
          </option>
        ))}
      </optgroup>
      <optgroup label="Alle Länder">
        {COUNTRIES.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </optgroup>
      {extra.length > 0 && (
        <optgroup label="Sonstiges">
          {extra.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

/** Land als Auswahl mit deutschen Namen; gespeichert wird der ISO-Code. */
export function CountrySelect({
  label,
  value,
  onChange,
  required,
  highlighted = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  highlighted?: boolean;
}) {
  return (
    <Labeled label={label} required={required} highlighted={highlighted}>
      {(control) => (
        <select
          {...control}
          value={value}
          required={required}
          onChange={(event) => onChange(event.target.value)}
        >
          <CountryOptions value={value} />
        </select>
      )}
    </Labeled>
  );
}

const OTHER_NATIONALITIES = ['staatenlos', 'ungeklärt'] as const;

/**
 * Staatsangehörigkeit(en) als Auswahl; mehrere werden als „DE, TR“ gespeichert
 * (ISO-Codes, dazu „staatenlos“ bzw. „ungeklärt“).
 */
export function NationalitySelect({
  label,
  value,
  onChange,
  required,
  highlighted = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  highlighted?: boolean;
}) {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const [adding, setAdding] = useState(false);
  const save = (next: string[]) => onChange(next.join(', '));
  return (
    <div className="space-y-2">
      <Labeled label={label} required={required} highlighted={highlighted}>
        {(control) => (
          <select
            {...control}
            value={parts[0] ?? ''}
            required={required}
            onChange={(event) => save([event.target.value, ...parts.slice(1)])}
          >
            <CountryOptions value={parts[0] ?? ''} extra={OTHER_NATIONALITIES} />
          </select>
        )}
      </Labeled>
      {parts.slice(1).map((part, index) => (
        <div key={`${part}-${index}`} className="flex items-center gap-2">
          <select
            className="input"
            aria-label={`Weitere Staatsangehörigkeit ${index + 1}`}
            value={part}
            onChange={(event) =>
              save(parts.map((entry, at) => (at === index + 1 ? event.target.value : entry)))
            }
          >
            <CountryOptions value={part} />
          </select>
          <button
            type="button"
            className="btn-secondary"
            aria-label={`Weitere Staatsangehörigkeit ${index + 1} entfernen`}
            onClick={() => save(parts.filter((_, at) => at !== index + 1))}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      {adding ? (
        <select
          className="input"
          aria-label="Weitere Staatsangehörigkeit"
          value=""
          onChange={(event) => {
            setAdding(false);
            if (event.target.value) save([...parts, event.target.value]);
          }}
        >
          <CountryOptions value="" />
        </select>
      ) : (
        parts.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-secondary hover:text-primary"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-4 w-4" /> Weitere Staatsangehörigkeit
          </button>
        )
      )}
    </div>
  );
}
