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

import { useState } from 'react';
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
  name,
  defaultValue,
  required = false,
  className,
  minDate,
}: {
  /** FormData-Key — versteckter Input mit ISO-Wert (YYYY-MM-DDTHH:MM) */
  name: string;
  /** Vorbelegung als Date oder ISO-String */
  defaultValue?: Date | string | null;
  required?: boolean;
  className?: string;
  /** Frühestes wählbares Datum (z. B. "heute" für Termin-Anfragen) */
  minDate?: Date;
}) {
  const [date, setDate] = useState<Date | null>(() => {
    if (!defaultValue) return null;
    return typeof defaultValue === 'string' ? new Date(defaultValue) : defaultValue;
  });

  return (
    <div className="relative">
      <DatePicker
        selected={date}
        onChange={(d: Date | null) => setDate(d ?? null)}
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
        // wrapperClassName sorgt dafür, dass der DatePicker volle Breite einnimmt
        wrapperClassName="w-full"
      />
      <input
        type="hidden"
        name={name}
        value={date ? toLocalIsoMinute(date) : ''}
        required={required}
      />
    </div>
  );
}
