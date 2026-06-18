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
const TIME_ZONE = 'Europe/Berlin';

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

// Dezimalzahl mit konfigurierbarer Nachkommastellen-Obergrenze. Formatter
// werden pro Stellenzahl gecacht (selten viele verschiedene Werte).
const decimalFormatters = new Map<number, Intl.NumberFormat>();

/** Dezimalzahl, deutsche Schreibweise, max. `maxFractionDigits` Nachkommastellen. */
export function fmtDecimal(n: number | null | undefined, maxFractionDigits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  let f = decimalFormatters.get(maxFractionDigits);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxFractionDigits });
    decimalFormatters.set(maxFractionDigits, f);
  }
  return f.format(n);
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

const dateShortFormatter = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE });
const dateNumericFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeZone: TIME_ZONE });
const dateMediumFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: TIME_ZONE });
const dateLongFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeZone: TIME_ZONE });
const dateWeekdayLongFormatter = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: TIME_ZONE });
const timeShortFormatter = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
const timeMediumFormatter = new Intl.DateTimeFormat(LOCALE, { timeStyle: 'medium', timeZone: TIME_ZONE });
const dateTimeShortFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
const dateTimeMediumFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE });
const dateTimeLongFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeStyle: 'medium', timeZone: TIME_ZONE });
const dateTimeSecondsFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'medium', timeZone: TIME_ZONE });
const weekdayShortFormatter = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', timeZone: TIME_ZONE });
const dayFormatter = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', timeZone: TIME_ZONE });
const monthShortFormatter = new Intl.DateTimeFormat(LOCALE, { month: 'short', timeZone: TIME_ZONE });
const monthYearFormatter = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric', timeZone: TIME_ZONE });

/** `12.5.2026` (numerisch, ohne Null-Padding) */
export function fmtDateShort(d: Date): string { return dateShortFormatter.format(d); }
/** `12.05.26` (numerisch, zweistellig gepaddet, 2-stelliges Jahr) */
export function fmtDateNumeric(d: Date): string { return dateNumericFormatter.format(d); }
/** `12. Mai 2026` */
export function fmtDateMedium(d: Date): string { return dateMediumFormatter.format(d); }
/** `12. Mai 2026` (Long-Variante, ähnlich Medium im de-DE) */
export function fmtDateLong(d: Date): string { return dateLongFormatter.format(d); }
/** `Montag, 12. Mai 2026` */
export function fmtDateWeekdayLong(d: Date): string { return dateWeekdayLongFormatter.format(d); }

/** `14:35` */
export function fmtTimeShort(d: Date): string { return timeShortFormatter.format(d); }
/** `14:35:21` */
export function fmtTimeMedium(d: Date): string { return timeMediumFormatter.format(d); }

/** `12.05.26, 14:35` */
export function fmtDateTimeShort(d: Date): string { return dateTimeShortFormatter.format(d); }
/** `12. Mai 2026, 14:35` */
export function fmtDateTimeMedium(d: Date): string { return dateTimeMediumFormatter.format(d); }
/** `12. Mai 2026 um 14:35:21` */
export function fmtDateTimeLong(d: Date): string { return dateTimeLongFormatter.format(d); }
/** `12.05.26, 14:35:21` */
export function fmtDateTimeSeconds(d: Date): string { return dateTimeSecondsFormatter.format(d); }

/** `Mo`, `Di`, … */
export function fmtWeekdayShort(d: Date): string { return weekdayShortFormatter.format(d); }
/** `12` (Tag, zweistellig) */
export function fmtDay(d: Date): string { return dayFormatter.format(d); }
/** `Mai` (Monat, Kurzform) */
export function fmtMonthShort(d: Date): string { return monthShortFormatter.format(d); }
/** `Mai 2026` */
export function fmtMonthYear(d: Date): string { return monthYearFormatter.format(d); }

// --- Dauer ---------------------------------------------------------------------

/** Minuten → `2h 15m` oder `15m`. */
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}
