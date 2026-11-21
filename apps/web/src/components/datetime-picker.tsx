'use client';

/**
 * Einheitlicher DateTime-Picker für alle Browser.
 *
 * Browser-natives `<input type="datetime-local">` rendert in Firefox/Safari
 * anders als in Chrome/Edge — speziell der Zeit-Spinner fehlt. Diese
 * Komponente kapselt `react-datepicker` mit deutscher Lokalisierung und
 * 15-Minuten-Zeit-Auswahl.
 *
 * Funktioniert mit Server-Actions / FormData: zusätzlich zu dem sichtbaren
 * Picker rendert sie einen versteckten `<input>` mit dem konfigurierten
 * `name` und einem ISO-Wert im Format `YYYY-MM-DDTHH:MM` (so wie ein
 * `datetime-local` Browser-Input es liefern würde).
 */

import { useId, useState } from 'react';
import DatePicker, { registerLocale } from 'react-datepicker';
import { de } from 'date-fns/locale/de';
import 'react-datepicker/dist/react-datepicker.css';

registerLocale('de', de);

function toLocalIsoMinute(d: Date): string {
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 16);
}

function needsNativeWallTime(
  value: string | null | undefined,
  serialized: string,
  output: 'local' | 'utc',
  editing: boolean,
): boolean {
  if (output !== 'local' || value === undefined) return false;
  return (
    editing ||
    Boolean(value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && value !== serialized)
  );
}

export function DateTimePicker({
  id,
  name,
  defaultValue,
  value,
  onChange,
  required = false,
  className,
  minDate,
  disabled = false,
  output = 'local',
  ariaInvalid = false,
  ariaDescribedBy,
}: {
  id?: string;
  /** FormData-Key — versteckter Input mit ISO-Wert (YYYY-MM-DDTHH:MM) */
  name: string;
  /** Vorbelegung als Date oder ISO-String */
  defaultValue?: Date | string | null;
  /** Kontrollierter lokaler Wert (YYYY-MM-DDTHH:MM), z. B. für Vorlagen. */
  value?: string | null;
  /** Meldet kontrollierten lokalen Wert zurück. */
  onChange?: (value: string) => void;
  required?: boolean;
  className?: string;
  /** Frühestes wählbares Datum (z. B. "heute" für Termin-Anfragen) */
  minDate?: Date;
  disabled?: boolean;
  /** UTC liefert einen vollständigen ISO-Zeitstempel für z.string().datetime(). */
  output?: 'local' | 'utc';
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [editingNativeTime, setEditingNativeTime] = useState(false);
  const [internalDate, setInternalDate] = useState<Date | null>(() => {
    if (!defaultValue) return null;
    return typeof defaultValue === 'string' ? new Date(defaultValue) : defaultValue;
  });
  const controlled = value !== undefined;
  const controlledDate = value ? new Date(value) : null;
  const date = controlled ? controlledDate : internalDate;
  const serialized = date ? (output === 'utc' ? date.toISOString() : toLocalIsoMinute(date)) : '';

  // Ein lokales Date verschiebt z. B. 02:30 nach 03:30 während der amerikanischen
  // Frühjahrsumstellung, obwohl die Berliner Vorlagenzeit existiert. Das native
  // datetime-local-Feld kann genau diese Uhrzeit anzeigen und unverändert übermitteln.
  const inputProps = {
    id: inputId,
    className: 'input text-sm w-full ' + (className ?? ''),
    disabled,
    required,
    autoComplete: 'off',
  };
  if (needsNativeWallTime(value, serialized, output, editingNativeTime)) {
    return (
      <input
        {...inputProps}
        name={name}
        type="datetime-local"
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value)}
        onFocus={() => setEditingNativeTime(true)}
        onBlur={() => setEditingNativeTime(false)}
        min={minDate ? toLocalIsoMinute(minDate) : undefined}
        aria-required={required ? 'true' : undefined}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
      />
    );
  }

  return (
    <div className="relative">
      <DatePicker
        {...inputProps}
        selected={date}
        onChange={(next: Date | null) => {
          if (!controlled) setInternalDate(next ?? null);
          onChange?.(next ? toLocalIsoMinute(next) : '');
        }}
        showTimeSelect
        timeIntervals={15}
        timeFormat="HH:mm"
        timeCaption="Uhrzeit"
        dateFormat="dd.MM.yyyy HH:mm"
        locale="de"
        minDate={minDate}
        placeholderText="Datum + Uhrzeit auswählen"
        aria-required={required ? 'true' : undefined}
        ariaInvalid={ariaInvalid ? 'true' : undefined}
        ariaDescribedBy={ariaDescribedBy}
        // wrapperClassName sorgt dafür, dass der DatePicker volle Breite einnimmt
        popperClassName="taxtronik-datetime-popper"
        calendarClassName="taxtronik-datetime-calendar"
        // Popup an document.body portalisieren: in Scroll-/Overflow-Containern
        // (z. B. Quick-Anforderungs-Dialog mit overflow-y-auto) würde der
        // Kalender sonst am Container-Rand abgeschnitten.
        portalId="taxtronik-datetime-portal"
        popperPlacement="bottom-end"
        showPopperArrow={false}
        wrapperClassName="w-full"
      />
      <input type="hidden" name={name} value={serialized} disabled={disabled} />
    </div>
  );
}
