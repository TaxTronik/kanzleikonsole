// =============================================================================
// Zeitfenster und Gruppierung des Kontrollkalenders (TCMS Stufe 3, portiert
// aus der Demo staff/clients/[id]/tcms/kalender/page.tsx). Reine Anzeige:
// Welche zwölf Monate gezeigt werden und in welchen Monat eine Durchführung
// nach ihrer Fälligkeit (Angabe des Dienstes) fällt. Status und Fälligkeit
// berechnet der Dienst.
// =============================================================================

import type { KontextAntwort } from '@taxtronik/tcms-contract';
import { monatSchluessel, MONATE } from '@taxtronik/tcms-domain';
import { alsDatum } from '../format';

type Durchfuehrung = KontextAntwort['durchfuehrungen'][number];

const MONAT_PARAM = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Erster Tag des Monats von `d` plus `n` Monate (UTC). */
export function monatPlus(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

export interface Zeitfenster {
  /** Zwölf Monatsanfänge (UTC). */
  monate: Date[];
  /** `YYYY-MM` je Monat. */
  schluessel: string[];
  start: Date;
  /** Gültiger `ab`-Parameter (`YYYY-MM`) für Links, sonst `null`. */
  ab: string | null;
}

/**
 * Zwölf Monate ab `ab` (`YYYY-MM`, falls gültig), sonst ab Wirksamkeitsbeginn,
 * solange dessen Jahresfenster den Stichtag enthält, sonst ab Januar des
 * Stichtagsjahres (wie die Demo).
 */
export function zeitfenster(abParam: string, stand: string, wirksamAb: string | null): Zeitfenster {
  const standMonat = monatPlus(alsDatum(stand) ?? new Date(), 0);
  const ab = alsDatum(wirksamAb);
  let start: Date;
  const m = MONAT_PARAM.exec(abParam);
  if (m) {
    start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  } else if (ab && monatPlus(ab, 12).getTime() > standMonat.getTime()) {
    start = monatPlus(ab, 0);
  } else {
    start = new Date(Date.UTC(standMonat.getUTCFullYear(), 0, 1));
  }
  const monate = Array.from({ length: 12 }, (_, i) => monatPlus(start, i));
  return { monate, schluessel: monate.map(monatSchluessel), start, ab: m ? abParam : null };
}

/** „Jan 26“ */
export function monatKurz(d: Date): string {
  return `${(MONATE[d.getUTCMonth()] ?? '').slice(0, 3)} ${String(d.getUTCFullYear()).slice(2)}`;
}

/** Durchführungen je Kontrolle und Fälligkeitsmonat (`<kontrolleId>|YYYY-MM`). */
export function jeKontrolleUndMonat(
  durchfuehrungen: readonly Durchfuehrung[],
): Map<string, Durchfuehrung[]> {
  const je = new Map<string, Durchfuehrung[]>();
  for (const d of durchfuehrungen) {
    const faellig = alsDatum(d.faelligAm);
    if (!faellig) continue;
    const key = `${d.kontrolleId}|${monatSchluessel(faellig)}`;
    je.set(key, [...(je.get(key) ?? []), d]);
  }
  return je;
}

/** Liegt der Monat im hinterlegten Wirksamkeitszeitraum (Angaben des Programms)? */
export function imZeitraum(monat: Date, wirksamAb: string | null, wirksamBis: string | null) {
  const ab = alsDatum(wirksamAb);
  const bis = alsDatum(wirksamBis);
  if (!ab || !bis) return false;
  return (
    monat.getTime() >= monatPlus(ab, 0).getTime() && monat.getTime() <= monatPlus(bis, 0).getTime()
  );
}
