// =============================================================================
// Tax-Calendar-Helpers
//
// Geteilt zwischen `/staff/calendar` und `/staff/tax-deadlines`. Vorher
// identisch in beiden Pages inline definiert.
// =============================================================================

import type { TaxScheduleKind } from '@prisma/client';
import { berlinDayStartUtc, berlinYmd } from '@/lib/fmt';

/**
 * UTC-Instants des gewaehlten Europe/Berlin-Kalendermonats. Das Ende ist
 * exklusiv, damit ein Termin exakt um 00:00 Berlin des Folgemonats nicht mehr
 * in den Vormonat faellt. Die Laenge kann wegen der Zeitumstellung von der
 * reinen Anzahl Kalendertage mal 24 Stunden abweichen.
 */
export function berlinMonthBoundsUtc(
  year: number,
  month0: number,
): { start: Date; endExclusive: Date } {
  const normalizedStart = new Date(Date.UTC(year, month0, 1));
  const normalizedEnd = new Date(Date.UTC(year, month0 + 1, 1));
  const asYmd = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const start = berlinDayStartUtc(asYmd(normalizedStart));
  const endExclusive = berlinDayStartUtc(asYmd(normalizedEnd));
  if (!start || !endExclusive) {
    throw new RangeError('Ungueltiger Kalendermonat.');
  }
  return { start, endExclusive };
}

/**
 * Parst einen `?month=YYYY-MM`-Query-Parameter. Bei fehlend/invalid: aktueller
 * Monat (Europe/Berlin). Rückgabe ist 0-basiert für JS-Date-Konsumenten.
 */
export function parseMonth(s: string | undefined): { year: number; month0: number } {
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    return { year: y!, month0: (m ?? 1) - 1 };
  }
  // Berlin-Monat, nicht UTC: am Monatsersten zwischen 00:00–02:00 Berlin würde
  // getUTCMonth() sonst den Vormonat aufschlagen.
  const [y, m] = berlinYmd(new Date()).split('-').map(Number);
  return { year: y!, month0: (m ?? 1) - 1 };
}

/**
 * Kompaktes Pill-Label für Steuertermin-Arten — bewusst kürzer als
 * `SCHEDULE_LABELS` für Kalender-Zellen, in denen Platz knapp ist.
 */
const SHORT_KIND_LABELS: Record<string, string> = {
  USTA_MONATLICH: 'USt-VA',
  USTA_QUARTAL: 'USt-VA',
  USTA_JAEHRLICH: 'USt-Jahr',
  LSTA_MONATLICH: 'LSt',
  LSTA_QUARTAL: 'LSt',
  LSTA_JAEHRLICH: 'LSt-Jahr',
  EST_VZ: 'ESt-VZ',
  KST_VZ: 'KSt-VZ',
  GEWST_VZ: 'GewSt-VZ',
  EST_ERKLAERUNG: 'ESt-Erkl.',
  KST_ERKLAERUNG: 'KSt-Erkl.',
  GEWST_ERKLAERUNG: 'GewSt-Erkl.',
};

export function shortKind(k: TaxScheduleKind | string): string {
  return SHORT_KIND_LABELS[k] ?? k;
}
