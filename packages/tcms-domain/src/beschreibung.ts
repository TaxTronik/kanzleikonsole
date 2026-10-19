// =============================================================================
// Gliederung der CMS-Beschreibung (Fachkonzept S14): 0 Teilbereich, 1–7
// Grundelemente, Anhang. „Lebende Bausteine" werden aus den strukturierten
// Daten gerendert und beim Freigeben eingefroren.
// =============================================================================

import type { GrundelementKey } from './grundelemente';

export type BausteinArt =
  | 'TEILBEREICH'
  | 'ZIELE'
  | 'RISIKOINVENTAR'
  | 'KONTROLLMATRIX'
  | 'VERANTWORTUNG'
  | 'LAENDER'
  | 'FESTSTELLUNGEN';

export const BAUSTEIN_LABEL: Record<BausteinArt, string> = {
  TEILBEREICH: 'Teilbereich und Abgrenzung',
  ZIELE: 'Compliance-Ziele',
  RISIKOINVENTAR: 'Risikoinventar (Auszug)',
  KONTROLLMATRIX: 'Kontrollmatrix',
  VERANTWORTUNG: 'Verantwortungsmatrix',
  LAENDER: 'Länderübersicht',
  FESTSTELLUNGEN: 'Offene Feststellungen',
};

export const BAUSTEIN_QUELLE: Record<BausteinArt, string> = {
  TEILBEREICH: 'Teilbereich',
  ZIELE: 'den Compliance-Zielen',
  RISIKOINVENTAR: 'dem Risikoinventar',
  KONTROLLMATRIX: 'der Kontrollmatrix',
  VERANTWORTUNG: 'den Zuständigkeiten der Kontrollen',
  LAENDER: 'dem Länder-Monitor',
  FESTSTELLUNGEN: 'den Feststellungen',
};

export type AbschnittKey = 'teilbereich' | GrundelementKey | 'anhang';

export interface AbschnittVorlage {
  key: AbschnittKey;
  nr: string;
  titel: string;
}

export const ABSCHNITTE: readonly AbschnittVorlage[] = [
  { key: 'teilbereich', nr: '0', titel: 'Teilbereich und Abgrenzung' },
  { key: 'kultur', nr: '1', titel: 'Compliance-Kultur' },
  { key: 'ziele', nr: '2', titel: 'Compliance-Ziele' },
  { key: 'risiken', nr: '3', titel: 'Compliance-Risiken' },
  { key: 'programm', nr: '4', titel: 'Compliance-Programm' },
  { key: 'organisation', nr: '5', titel: 'Compliance-Organisation' },
  { key: 'kommunikation', nr: '6', titel: 'Compliance-Kommunikation' },
  { key: 'ueberwachung', nr: '7', titel: 'Überwachung und Verbesserung' },
  { key: 'anhang', nr: 'A', titel: 'Anhang' },
];

/** Ein Abschnitt: Freitextblöcke und eingebettete Bausteine in Reihenfolge. */
export type Block = { typ: 'text'; text: string } | { typ: 'baustein'; art: BausteinArt };

export interface Abschnitt {
  key: AbschnittKey;
  bloecke: Block[];
}

export function abschnittHatText(a: Abschnitt | undefined): boolean {
  return !!a && a.bloecke.some((b) => b.typ === 'text' && b.text.trim().length > 0);
}

/** Nächste Versionsnummer: 1.3 → 1.4. */
export function naechsteVersion(nummer: string | null): string {
  if (!nummer) return '1.0';
  const [haupt, neben] = nummer.split('.').map((x) => Number.parseInt(x, 10));
  return `${haupt ?? 1}.${(neben ?? 0) + 1}`;
}
