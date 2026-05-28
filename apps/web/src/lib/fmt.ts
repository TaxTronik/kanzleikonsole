// =============================================================================
// Format-Helper — zentrale Stelle für alle de-DE-formatierten Ausgaben.
//
// Vorher in vielen Dateien lokal als Inline `new Intl.DateTimeFormat(...)`
// oder als Inline `fmtEUR`/`fmtEur` (sic) dupliziert. Die Inline-Formatter
// hatten subtile Inkonsistenzen (locale-Schreibweise, Optionen, Naming).
//
// Konvention: alle Date-Formatter heißen `fmtDate*` / `fmtTime*` / `fmtMonth*`.
// Alle Money-Formatter heißen `fmtEUR` (groß, ISO-4217-Code).
//
// Performance: `Intl.DateTimeFormat`-Instanzen werden modulweit gecacht
// (Module-Load = einmal). Wiederholte `.format(date)`-Aufrufe sind günstig.
// =============================================================================

const LOCALE = 'de-DE';

// --- Numerisch -----------------------------------------------------------------

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const eurFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'EUR',
});

/**
 * Geldbetrag in Euro, deutsche Schreibweise. Akzeptiert:
 *   - `number`
 *   - `string` (z. B. `"123.45"`)
 *   - Prisma `Decimal` (oder beliebiges Objekt mit `.toString()`)
 *   - `null`/`undefined` → `—`
 * Nicht-finite Werte (NaN, Infinity) ergeben ebenfalls `—`.
 */
export function fmtEUR(n: number | string | { toString(): string } | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'number' ? n : Number(typeof n === 'string' ? n : n.toString());
  if (!Number.isFinite(num)) return '—';
  return eurFormatter.format(num);
}

const eurRoundFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

/** Wie `fmtEUR`, aber ohne Cent-Stellen (für große BWA-Beträge in Übersichten). */
export function fmtEURRound(n: number | string | { toString(): string } | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const num = typeof n === 'number' ? n : Number(typeof n === 'string' ? n : n.toString());
  if (!Number.isFinite(num)) return '—';
  return eurRoundFormatter.format(num);
}

const numberFormatter = new Intl.NumberFormat(LOCALE);

/** Ganzzahl / Dezimalzahl mit deutschen Tausender-/Dezimaltrennzeichen. */
export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return numberFormatter.format(n);
}

const percentFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** Prozentwert (Eingabe als Dezimalbruch — 0.5 → "50 %"). */
export function fmtPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return percentFormatter.format(n);
}

// --- Datum / Zeit --------------------------------------------------------------

const dateShortFormatter = new Intl.DateTimeFormat(LOCALE);
const dateMediumFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });
const dateLongFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long' });
const timeShortFormatter = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const timeMediumFormatter = new Intl.DateTimeFormat(LOCALE, { timeStyle: 'medium' });
const dateTimeShortFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'short' });
const dateTimeMediumFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
const dateTimeSecondsFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'medium' });
const weekdayShortFormatter = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const monthYearFormatter = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

/** `12.05.2026` */
export function fmtDateShort(d: Date): string { return dateShortFormatter.format(d); }
/** `12. Mai 2026` */
export function fmtDateMedium(d: Date): string { return dateMediumFormatter.format(d); }
/** `12. Mai 2026` (Long-Variante, ähnlich Medium im de-DE) */
export function fmtDateLong(d: Date): string { return dateLongFormatter.format(d); }

/** `14:35` */
export function fmtTimeShort(d: Date): string { return timeShortFormatter.format(d); }
/** `14:35:21` */
export function fmtTimeMedium(d: Date): string { return timeMediumFormatter.format(d); }

/** `12.05.26, 14:35` */
export function fmtDateTimeShort(d: Date): string { return dateTimeShortFormatter.format(d); }
/** `12. Mai 2026, 14:35` */
export function fmtDateTimeMedium(d: Date): string { return dateTimeMediumFormatter.format(d); }
/** `12.05.26, 14:35:21` */
export function fmtDateTimeSeconds(d: Date): string { return dateTimeSecondsFormatter.format(d); }

/** `Mo`, `Di`, … */
export function fmtWeekdayShort(d: Date): string { return weekdayShortFormatter.format(d); }
/** `Mai 2026` */
export function fmtMonthYear(d: Date): string { return monthYearFormatter.format(d); }

// --- Dauer ---------------------------------------------------------------------

/** Minuten → `2h 15m` oder `15m`. */
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}
