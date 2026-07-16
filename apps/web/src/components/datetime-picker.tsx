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
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [internalDate, setInternalDate] = useState<Date | null>(() => {
    if (!defaultValue) return null;
    return typeof defaultValue === 'string' ? new Date(defaultValue) : defaultValue;
  });
  const controlled = value !== undefined;
  const controlledDate = value ? new Date(value) : null;
  const date = controlled ? controlledDate : internalDate;
  const serialized = date ? (output === 'utc' ? date.toISOString() : toLocalIsoMinute(date)) : '';

  return (
    <div className="relative">
      <DatePicker
        id={inputId}
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
        className={'input text-sm w-full ' + (className ?? '')}
        autoComplete="off"
        disabled={disabled}
        required={required}
        aria-required={required ? 'true' : undefined}
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
      <input type="hidden" name={name} value={serialized} />
    </div>
  );
}
