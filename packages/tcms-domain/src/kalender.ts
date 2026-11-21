// =============================================================================
// Kalendertage nach deutschem Kalender (Europe/Berlin). Fristen, Stichtage und
// „heute" gelten nach dem Berliner Kalendertag (ADR 0001 §7); dieselbe Regel
// ordnet Zeitpunkte (Einreichung, Abschluss, Erfassung, Audit …) einem Tag zu.
// Eine Implementierung für Domain, Dienst und Demo.
//
// Darstellung: Kalendertage sind Date auf UTC-Mitternacht (`utc`, Spalten vom
// Typ DATE), Zeitpunkte echte Instants. `kalendertagVon` bildet beide auf
// denselben Tag ab: UTC-Mitternacht liegt in Berlin (UTC+1 bzw. UTC+2) am
// selben Kalendertag, ein Zeitpunkt zählt zu dem Berliner Tag, an dem er liegt
// (2026-11-16T23:30Z ist der 17.11.).
// =============================================================================

/** Zeitzone für Kalendertage: Fristen und Stichtage gelten nach deutschem Kalendertag. */
export const ZEITZONE = 'Europe/Berlin';

const TAG_MS = 86_400_000;

const wanduhrFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZEITZONE,
  hourCycle: 'h23',
  era: 'short',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Berliner Wanduhrzeit eines Zeitpunkts als UTC-Millisekunden (sekundengenau). */
function wanduhr(ms: number): number {
  const t: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  let vorZeitrechnung = false;
  for (const p of wanduhrFormat.formatToParts(new Date(ms))) {
    if (p.type === 'era') vorZeitrechnung = p.value === 'BC';
    else if (p.type !== 'literal') t[p.type] = Number(p.value);
  }
  const jahr = vorZeitrechnung ? 1 - t.year! : t.year!;
  if (jahr >= 100) return Date.UTC(jahr, t.month! - 1, t.day!, t.hour!, t.minute!, t.second!);
  // Date.UTC addiert bei Jahren von 0 bis 99 stillschweigend 1900.
  const d = new Date(0);
  d.setUTCFullYear(jahr, t.month! - 1, t.day!);
  return d.setUTCHours(t.hour!, t.minute!, t.second!, 0);
}

/** Abstand der Berliner Wanduhr zu UTC in Millisekunden (+1 h bzw. +2 h). */
function versatz(ms: number): number {
  return wanduhr(ms) - (ms - (((ms % 1000) + 1000) % 1000));
}

/** UTC-Mitternacht des Berliner Kalendertags, an dem `d` liegt (NaN bei ungültigem Datum). */
function tagMs(d: Date): number {
  const ms = d.getTime();
  if (Number.isNaN(ms)) return Number.NaN;
  // Kalendertag (UTC-Mitternacht): in Berlin derselbe Tag – ohne Intl.
  if (ms % TAG_MS === 0) return ms;
  const w = wanduhr(ms);
  return w - (((w % TAG_MS) + TAG_MS) % TAG_MS);
}

/**
 * Berliner Kalendertag eines Zeitpunkts als Date auf UTC-Mitternacht. Ein
 * Kalendertag (UTC-Mitternacht) bleibt unverändert.
 */
export function kalendertagVon(d: Date): Date {
  return new Date(tagMs(d));
}

/** Berliner Kalendertag eines Zeitpunkts als `YYYY-MM-DD`. */
export function kalendertag(d: Date): string {
  return new Date(tagMs(d)).toISOString().slice(0, 10);
}

/** Jahr des Berliner Kalendertags (z. B. für Nummernkreise). */
export function kalenderjahr(d: Date): number {
  return new Date(tagMs(d)).getUTCFullYear();
}

/** true, wenn `a` an einem späteren Kalendertag liegt als `b`. */
export function nachTag(a: Date, b: Date): boolean {
  return tagMs(a) > tagMs(b);
}

/** Kalendertage zwischen zwei Daten bzw. Zeitpunkten (b − a). */
export function tageZwischen(a: Date, b: Date): number {
  return Math.round((tagMs(b) - tagMs(a)) / TAG_MS);
}

/** Erster Zeitpunkt (00:00 Uhr in Berlin) des Kalendertags von `tag`. */
export function tagesbeginn(tag: Date): Date {
  const u = tagMs(tag);
  if (Number.isNaN(u)) return new Date(Number.NaN);
  // Mitternacht liegt in Berlin nie in einer Umstellungslücke (02:00/03:00 Uhr);
  // der zweite Schritt prüft den Versatz am gefundenen Zeitpunkt selbst.
  const naeherung = u - versatz(u);
  return new Date(u - versatz(naeherung));
}

/**
 * Letzte Millisekunde des Berliner Kalendertags von `tag` – Obergrenze für
 * Stichtagsvergleiche mit Zeitpunkten (`zeitpunkt <= tagesende(stand)`).
 */
export function tagesende(tag: Date): Date {
  const u = tagMs(tag);
  if (Number.isNaN(u)) return new Date(Number.NaN);
  return new Date(tagesbeginn(new Date(u + TAG_MS)).getTime() - 1);
}
