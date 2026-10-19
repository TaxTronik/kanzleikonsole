// =============================================================================
// Bewertungslogik (Fachkonzept Abschnitt 8). Reine, versionierte Funktion:
// Brutto- und Nettoklassen werden berechnet und nie gespeichert-überschrieben.
// Eine Übersteuerung ist ein eigenes Objekt; der berechnete Wert bleibt sichtbar.
// =============================================================================

import {
  KLASSE_LABEL,
  KLASSE_RANG,
  SCHADEN_LABEL,
  WAHRSCHEINLICHKEIT_LABEL,
  type Design,
  type Klasse,
  type KontrollArt,
  type Reichweite,
  type Schaden,
  type Wahrscheinlichkeit,
} from './types';

export const BEWERTUNGSMODELL_VERSION = 'ec-1.0';

const S_WERT: Record<Schaden, number> = { N: 1, M: 2, H: 3 };
const W_WERT: Record<Wahrscheinlichkeit, number> = {
  SELTEN: 1,
  MOEGLICH: 2,
  WAHRSCHEINLICH: 3,
  HAEUFIG: 4,
};

const RANG_ZU_KLASSE: Record<number, Klasse> = {
  1: 'GERING',
  2: 'MITTEL',
  3: 'HOCH',
  4: 'KRITISCH',
};

export function klasseAusRang(rang: number): Klasse {
  const r = Math.max(1, Math.min(4, Math.round(rang)));
  return RANG_ZU_KLASSE[r] as Klasse;
}

export function hoeher(a: Klasse, b: Klasse): Klasse {
  return KLASSE_RANG[a] >= KLASSE_RANG[b] ? a : b;
}

/** true, wenn `a` strikt über `b` liegt. */
export function ueber(a: Klasse, b: Klasse): boolean {
  return KLASSE_RANG[a] > KLASSE_RANG[b];
}

export function score(s: Schaden, w: Wahrscheinlichkeit): number {
  return S_WERT[s] * W_WERT[w];
}

export function klasseAusScore(punkte: number): Klasse {
  if (punkte <= 2) return 'GERING';
  if (punkte <= 4) return 'MITTEL';
  if (punkte <= 8) return 'HOCH';
  return 'KRITISCH';
}

export interface BruttoErgebnis {
  klasse: Klasse;
  punkte: number;
  basis: Klasse;
  angehoben: boolean;
  erklaerung: string;
}

/** Bruttoklasse = S × W; Reichweite 3 hebt um eine Klasse, höchstens bis kritisch. */
export function brutto(s: Schaden, w: Wahrscheinlichkeit, r: Reichweite): BruttoErgebnis {
  const punkte = score(s, w);
  const basis = klasseAusScore(punkte);
  const angehoben = r === 3 && basis !== 'KRITISCH';
  const klasse = angehoben ? klasseAusRang(KLASSE_RANG[basis] + 1) : basis;
  const teil = `${SCHADEN_LABEL[s]} × ${WAHRSCHEINLICHKEIT_LABEL[w]} = ${punkte} → ${KLASSE_LABEL[basis]}`;
  const zusatz =
    r === 3
      ? angehoben
        ? `; Reichweite 3 hebt auf ${KLASSE_LABEL[klasse]}`
        : '; Reichweite 3: bereits kritisch'
      : '';
  return { klasse, punkte, basis, angehoben, erklaerung: teil + zusatz };
}

/** Stand der letzten fälligen Durchführung einer Kontrolle (für Netto Betrieb). */
export type BetriebsStand =
  /** abgeschlossen ohne Befund und gegengezeichnet */
  | 'OK'
  | 'MIT_BEFUND'
  | 'UEBERFAELLIG'
  /** noch keine fällige oder abgeschlossene Durchführung */
  | 'KEINE';

export interface KontrolleFuerNetto {
  code: string;
  art: KontrollArt;
  design: Design;
  schluessel: boolean;
  betrieb: BetriebsStand;
}

export interface NettoErgebnis {
  klasse: Klasse;
  abschlag: 0 | 1 | 2;
  erklaerung: string;
  /** Kontrollen, deren Abschlag zählt. */
  zaehlend: string[];
}

function abschlagFuer(kontrollen: readonly KontrolleFuerNetto[]): {
  abschlag: 0 | 1 | 2;
  grund: string;
} {
  if (kontrollen.length === 0)
    return { abschlag: 0, grund: 'keine angemessen beurteilte Kontrolle' };
  const praeventiv = kontrollen.some((k) => k.art === 'P');
  const detektiv = kontrollen.some((k) => k.art === 'D');
  const praeventivSchluessel = kontrollen.some((k) => k.art === 'P' && k.schluessel);
  if (praeventiv && detektiv)
    return { abschlag: 2, grund: 'präventive und detektive Kontrolle angemessen' };
  if (praeventivSchluessel)
    return { abschlag: 2, grund: 'präventive Schlüsselkontrolle angemessen' };
  return { abschlag: 1, grund: 'mindestens eine Kontrolle angemessen' };
}

function anwenden(b: Klasse, abschlag: 0 | 1 | 2): Klasse {
  return klasseAusRang(Math.max(1, KLASSE_RANG[b] - abschlag));
}

/**
 * Netto (Design): −1 Klasse bei mindestens einer angemessen beurteilten
 * Kontrolle; −2 bei präventiver und detektiver Kontrolle oder präventiver
 * Schlüsselkontrolle. Untergrenze gering.
 */
export function nettoDesign(b: Klasse, kontrollen: readonly KontrolleFuerNetto[]): NettoErgebnis {
  const angemessen = kontrollen.filter((k) => k.design === 'ANGEMESSEN');
  const { abschlag, grund } = abschlagFuer(angemessen);
  const klasse = anwenden(b, abschlag);
  return {
    klasse,
    abschlag,
    erklaerung: abschlag === 0 ? `kein Abschlag: ${grund}` : `−${abschlag}: ${grund}`,
    zaehlend: angemessen.map((k) => k.code),
  };
}

/**
 * Netto (Betrieb): wie Design, aber der Abschlag einer Kontrolle zählt nur,
 * wenn ihre letzte fällige Durchführung ohne Befund abgeschlossen und
 * gegengezeichnet ist. Überfällig oder mit Befund → Abschlag entfällt.
 */
export function nettoBetrieb(b: Klasse, kontrollen: readonly KontrolleFuerNetto[]): NettoErgebnis {
  const zaehlend = kontrollen.filter((k) => k.design === 'ANGEMESSEN' && k.betrieb === 'OK');
  const { abschlag, grund } = abschlagFuer(zaehlend);
  const klasse = anwenden(b, abschlag);
  const ausfall = kontrollen
    .filter((k) => k.design === 'ANGEMESSEN' && k.betrieb !== 'OK')
    .map(
      (k) =>
        `${k.code} ${k.betrieb === 'UEBERFAELLIG' ? 'überfällig' : k.betrieb === 'MIT_BEFUND' ? 'mit Befund' : 'ohne Durchführung'}`,
    );
  const basis = abschlag === 0 ? `kein Abschlag: ${grund}` : `−${abschlag}: ${grund}`;
  return {
    klasse,
    abschlag,
    erklaerung: ausfall.length ? `${basis}; entfällt für ${ausfall.join(', ')}` : basis,
    zaehlend: zaehlend.map((k) => k.code),
  };
}

export interface RisikoBewertung {
  brutto: BruttoErgebnis;
  nettoDesign: NettoErgebnis;
  nettoBetrieb: NettoErgebnis;
  /** Wirksame Nettoklassen nach freigegebener Übersteuerung. */
  wirksamDesign: Klasse;
  wirksamBetrieb: Klasse;
  uebersteuertDesign: boolean;
  uebersteuertBetrieb: boolean;
  modell: string;
}

export interface Uebersteuerungen {
  design?: Klasse | null;
  betrieb?: Klasse | null;
}

export function bewerte(
  s: Schaden,
  w: Wahrscheinlichkeit,
  r: Reichweite,
  kontrollen: readonly KontrolleFuerNetto[],
  uebersteuert: Uebersteuerungen = {},
): RisikoBewertung {
  const b = brutto(s, w, r);
  const nd = nettoDesign(b.klasse, kontrollen);
  const nb = nettoBetrieb(b.klasse, kontrollen);
  return {
    brutto: b,
    nettoDesign: nd,
    nettoBetrieb: nb,
    wirksamDesign: uebersteuert.design ?? nd.klasse,
    wirksamBetrieb: uebersteuert.betrieb ?? nb.klasse,
    uebersteuertDesign: uebersteuert.design != null,
    uebersteuertBetrieb: uebersteuert.betrieb != null,
    modell: BEWERTUNGSMODELL_VERSION,
  };
}

/** Mindestlänge einer Begründung (Übersteuerung, Zurückweisung, Verwerfen). */
export const MIN_BEGRUENDUNG = 30;

export function begruendungGueltig(text: string | null | undefined): boolean {
  return (text ?? '').trim().length >= MIN_BEGRUENDUNG;
}
