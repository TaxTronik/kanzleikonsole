'use client';

import { useEffect, useId } from 'react';
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
  const id = useId();
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
        {required && <span className="text-red-700 ml-1">*</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        placeholder={placeholder}
        className={highlighted ? 'input border-emerald-600 ring-2 ring-emerald-500/40' : 'input'}
        data-identity-applied={highlighted || undefined}
        aria-describedby={highlighted ? `${id}-applied` : undefined}
      />
      {highlighted && (
        <p id={`${id}-applied`} className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
          Aus dem Ausweis übernommen – bitte prüfen.
        </p>
      )}
    </div>
  );
}
