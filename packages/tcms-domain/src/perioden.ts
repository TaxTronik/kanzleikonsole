// =============================================================================
// Perioden und Planung von Kontrolldurchführungen aus dem Turnus.
// Alle Daten als UTC-Mitternacht, damit Stichtagsvergleiche tagesgenau sind.
// =============================================================================

import type { Turnus } from './frequenz';

export const MONATE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

export function utc(jahr: number, monat1: number, tagNr: number): Date {
  return new Date(Date.UTC(jahr, monat1 - 1, tagNr));
}

export function addTage(d: Date, tage: number): Date {
  return new Date(d.getTime() + tage * 86_400_000);
}

export interface Periode {
  von: Date;
  bis: Date;
  label: string;
}

function letzterTag(jahr: number, monat1: number): Date {
  return new Date(Date.UTC(jahr, monat1, 0));
}

export function monatsPeriode(jahr: number, monat1: number): Periode {
  return {
    von: utc(jahr, monat1, 1),
    bis: letzterTag(jahr, monat1),
    label: `${MONATE[monat1 - 1]} ${jahr}`,
  };
}

export function quartalsPeriode(jahr: number, quartal: number): Periode {
  const start = (quartal - 1) * 3 + 1;
  return {
    von: utc(jahr, start, 1),
    bis: letzterTag(jahr, start + 2),
    label: `Q${quartal} ${jahr}`,
  };
}

export function jahresPeriode(jahr: number): Periode {
  return { von: utc(jahr, 1, 1), bis: utc(jahr, 12, 31), label: `Geschäftsjahr ${jahr}` };
}

/** Alle Perioden des Turnus, deren Ende in [von, bis] liegt. */
export function perioden(turnus: Turnus, von: Date, bis: Date): Periode[] {
  const out: Periode[] = [];
  if (turnus === 'KEIN') return out;
  for (let jahr = von.getUTCFullYear() - 1; jahr <= bis.getUTCFullYear(); jahr++) {
    const kandidaten =
      turnus === 'MONATLICH'
        ? Array.from({ length: 12 }, (_, i) => monatsPeriode(jahr, i + 1))
        : turnus === 'QUARTALSWEISE'
          ? [1, 2, 3, 4].map((q) => quartalsPeriode(jahr, q))
          : [jahresPeriode(jahr)];
    for (const p of kandidaten) {
      if (p.bis.getTime() >= von.getTime() && p.bis.getTime() <= bis.getTime()) out.push(p);
    }
  }
  return out;
}

export function monatSchluessel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monatLabel(d: Date): string {
  return `${MONATE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
