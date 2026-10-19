// =============================================================================
// Farbzuordnung der Tax-CMS-Oberflächen (TCMS Stufe 3) – nur Klassen aus
// apps/web/src/app/globals.css (badge-*, chip-*, dot-*), die hell und dunkel
// gestaltet sind. Keine eigenen Farben.
//
// Die Domain (@taxtronik/tcms-domain) führt eigene *_BADGE-Tabellen aus der
// Demo; sie nennen teils Klassen, die es hier nicht gibt (`badge-amber`).
// Deshalb gehen Domain-Klassen nur über `badgeKlasse()` (Whitelist) in die
// Oberfläche. Farbe ist nie der einzige Bedeutungsträger: jede Plakette trägt
// ihr Label aus der Domain.
// =============================================================================

import type { Klasse } from '@taxtronik/tcms-domain';

/** Badge-Klassen, die globals.css definiert (Test: ton.test.ts). */
export const BADGE_KLASSEN = [
  'badge-green',
  'badge-yellow',
  'badge-red',
  'badge-brand',
  'badge-purple',
  'badge-gray',
] as const;
export type BadgeKlasse = (typeof BADGE_KLASSEN)[number];

const ERSATZ: Readonly<Record<string, BadgeKlasse>> = { 'badge-amber': 'badge-yellow' };

/** Domain-Badge-Klasse → vorhandene Klasse; Unbekanntes wird grau. */
export function badgeKlasse(domainKlasse: string): BadgeKlasse {
  if ((BADGE_KLASSEN as readonly string[]).includes(domainKlasse)) {
    return domainKlasse as BadgeKlasse;
  }
  return ERSATZ[domainKlasse] ?? 'badge-gray';
}

/** Risikoklasse als Plakette (hoch und kritisch rot; kritisch zusätzlich mit Icon). */
export const KLASSE_BADGE_KLASSE: Readonly<Record<Klasse, BadgeKlasse>> = {
  GERING: 'badge-green',
  MITTEL: 'badge-yellow',
  HOCH: 'badge-red',
  KRITISCH: 'badge-red',
};

export const CHIP_KLASSEN = [
  'chip-brand',
  'chip-green',
  'chip-amber',
  'chip-red',
  'chip-gray',
] as const;
export type ChipKlasse = (typeof CHIP_KLASSEN)[number];

/** Risikoklasse als Kachel (Heatmap-Zellen). */
export const KLASSE_CHIP: Readonly<Record<Klasse, ChipKlasse>> = {
  GERING: 'chip-green',
  MITTEL: 'chip-amber',
  HOCH: 'chip-red',
  KRITISCH: 'chip-red',
};

/** Ton aus dem Domain-Katalog (Ereignistypen) → Kachel. */
export function tonChip(ton: string | undefined): ChipKlasse {
  switch (ton) {
    case 'green':
      return 'chip-green';
    case 'amber':
      return 'chip-amber';
    case 'red':
      return 'chip-red';
    default:
      return 'chip-brand';
  }
}
