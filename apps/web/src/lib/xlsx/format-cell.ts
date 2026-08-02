// =============================================================================
// Anzeige-Formatierung fuer XLSX-Zellwerte (Vorschau).
//
// Bewusst getrennt vom Viewer-Component, damit die Regeln testbar sind — die
// Datumsbehandlung ist die fehleranfaellige Stelle.
// =============================================================================

import type { XlsxValue } from './read-xlsx';

// Excel-Datumszellen sind Wanduhrzeit ohne Zonenbezug; der Reader legt sie in
// UTC ab. In lokaler Zone formatiert erschiene der 31.12. als "31.12., 01:00".
// Deshalb UTC — und ohne Uhrzeit, wenn die Zelle keine traegt.
const DATE_UTC = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  timeZone: 'UTC',
});
const DATE_TIME_UTC = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function formatXlsxDate(value: Date): string {
  const midnight =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;
  return midnight ? DATE_UTC.format(value) : DATE_TIME_UTC.format(value);
}

export function formatXlsxCell(value: XlsxValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toLocaleString('de-DE');
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return formatXlsxDate(value);
}
