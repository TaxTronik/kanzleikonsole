// =============================================================================
// Datumsanzeige für TCMS-Antworten (TCMS Stufe 3). Der Vertrag liefert
// Zeitpunkte als ISO-8601 (UTC) und Kalendertage als `YYYY-MM-DD`; die
// Formatierer der Domain (@taxtronik/tcms-domain: fmtDatum, fmtDatumKurz,
// fmtDatumZeit) erwarten `Date` und rechnen in UTC-Tagen. Ungültige Werte
// zeigen „—“, statt einen Tag zu raten.
// =============================================================================

import { fmtDatum, fmtDatumKurz, fmtDatumZeit, tageZwischen } from '@taxtronik/tcms-domain';

const KALENDERTAG = /^\d{4}-\d{2}-\d{2}$/;

/** ISO-Zeitpunkt oder Kalendertag → Date (UTC); sonst null. */
export function alsDatum(iso: string | null | undefined): Date | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(KALENDERTAG.test(iso) ? `${iso}T00:00:00.000Z` : iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function isoDatumText(iso: string | null | undefined): string {
  return fmtDatum(alsDatum(iso));
}

export function isoDatumKurzText(iso: string | null | undefined): string {
  return fmtDatumKurz(alsDatum(iso));
}

export function isoZeitText(iso: string | null | undefined): string {
  return fmtDatumZeit(alsDatum(iso));
}

/** Tage von `von` bis `bis` (beide ISO), null bei ungültigem Wert. */
export function isoTageZwischen(
  von: string | null | undefined,
  bis: string | null | undefined,
): number | null {
  const a = alsDatum(von);
  const b = alsDatum(bis);
  return a && b ? tageZwischen(a, b) : null;
}
