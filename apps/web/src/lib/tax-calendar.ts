// =============================================================================
// Tax-Calendar-Helpers
//
// Geteilt zwischen `/staff/calendar` und `/staff/tax-deadlines`. Vorher
// identisch in beiden Pages inline definiert.
// =============================================================================

import type { TaxScheduleKind } from '@prisma/client';

/**
 * Parst einen `?month=YYYY-MM`-Query-Parameter. Bei fehlend/invalid: aktueller
 * Monat (UTC). Rückgabe ist 0-basiert für JS-Date-Konsumenten.
 */
export function parseMonth(s: string | undefined): { year: number; month0: number } {
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    return { year: y!, month0: (m ?? 1) - 1 };
  }
  const now = new Date();
  return { year: now.getUTCFullYear(), month0: now.getUTCMonth() };
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
