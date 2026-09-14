'use client';

import { useEffect, useRef, useState } from 'react';

interface StaffOption {
  id: string;
  fullName: string;
  email: string;
  isProfessional: boolean;
}

export function ResponsibilityFields({ staff }: { staff: StaffOption[] }) {
  const [hasBerufstraeger, setHasBerufstraeger] = useState(false);
  const requiredRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasBerufstraeger) requiredRef.current?.setCustomValidity('');
  }, [hasBerufstraeger]);

  function onBerufstraegerChange() {
    const checked = document.querySelectorAll<HTMLInputElement>(
      'input[name="berufstraegerIds"]:checked',
    );
    setHasBerufstraeger(checked.length > 0);
  }

  return (
    <fieldset className="min-w-0 border border-default rounded-md p-4 space-y-4">
      <legend className="text-xs font-medium text-muted uppercase tracking-wide px-2">
        Zuständigkeit
      </legend>
      <p className="text-xs text-muted">
        Mindestens ein Berufsträger ist Pflicht. Diese Zuordnung steuert GwG-Verifikation,
        Benachrichtigungen und „Meine Mandanten".
      </p>

      <div>
        <p className="text-xs font-medium text-secondary mb-2">
          Berufsträger <span className="text-red-600">*</span>
        </p>
        <input
          ref={requiredRef}
          value={hasBerufstraeger ? 'ok' : ''}
          onChange={() => undefined}
          required
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onInvalid={(e) => {
            e.currentTarget.setCustomValidity('Bitte mindestens einen Berufsträger auswählen.');
          }}
          onInput={(e) => e.currentTarget.setCustomValidity('')}
        />
        <div className="max-h-48 overflow-auto rounded-md border border-default divide-y divide-border-subtle">
          {staff
            .filter((s) => s.isProfessional)
            .map((s) => (
              <label
                key={s.id}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 text-sm px-3 py-2"
              >
                <input
                  type="checkbox"
                  name="berufstraegerIds"
                  value={s.id}
                  onChange={onBerufstraegerChange}
                  className="row-span-2 rounded border-strong text-brand-600"
                />
                <span className="break-words text-primary">{s.fullName}</span>
                <span className="truncate text-xs text-muted">{s.email}</span>
              </label>
            ))}
          {!staff.some((s) => s.isProfessional) && (
            <p className="p-3 text-xs text-amber-700">
              Keine aktiven Berufsträger verfügbar. Bitte zuerst in der Benutzerverwaltung
              qualifizieren.
            </p>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-secondary mb-2">Hauptbearbeiter</p>
        <div className="max-h-48 overflow-auto rounded-md border border-default divide-y divide-border-subtle">
          {staff.map((s) => (
            <label
              key={s.id}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 text-sm px-3 py-2"
            >
              <input
                type="checkbox"
                name="hauptbearbeiterIds"
                value={s.id}
                className="row-span-2 rounded border-strong text-brand-600"
              />
              <span className="break-words text-primary">{s.fullName}</span>
              <span className="truncate text-xs text-muted">{s.email}</span>
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}
