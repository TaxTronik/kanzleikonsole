// =============================================================================
// Filter des Risikoinventars (TCMS Stufe 3, Demo components/risiken/filter.tsx).
// Die Demo filtert per Client-Router; hier per GET-Formular (ohne JavaScript,
// Lesezeichen möglich). Nur Werte aus festen Auswahlen werden übernommen. Die
// Filter wählen aus der Antwort des Dienstes aus – sie berechnen nichts.
// =============================================================================

import type { RisikoEintrag } from '@taxtronik/tcms-contract';
import {
  GOVERNANCE_TYPEN,
  KLASSE_RANG,
  KLASSEN,
  SCHAEDEN,
  WAHRSCHEINLICHKEITEN,
} from '@taxtronik/tcms-domain';
import { auswahlParam, param, type SuchParameter } from '../bereich-b/seite';

export const RISIKO_GRUPPEN = ['UST', 'GOB', 'ERT', 'VER'] as const;

export interface RisikoFilter {
  gruppe: (typeof RISIKO_GRUPPEN)[number] | '';
  gt: (typeof GOVERNANCE_TYPEN)[number] | '';
  klasse: (typeof KLASSEN)[number] | '';
  appetit: boolean;
  uebersteuert: boolean;
  kern: boolean;
  neu: boolean;
  /** Zelle der Heatmap (beide oder keiner). */
  s: (typeof SCHAEDEN)[number] | '';
  w: (typeof WAHRSCHEINLICHKEITEN)[number] | '';
}

/** Schlüssel der Filter (Reihenfolge der Links). */
export const RISIKO_FILTER_SCHLUESSEL = [
  'gruppe',
  'gt',
  'klasse',
  'appetit',
  'uebersteuert',
  'kern',
  'neu',
  's',
  'w',
] as const;

const ja = (sp: SuchParameter, name: string) => param(sp, name) === '1';

export function risikoFilterAus(sp: SuchParameter): RisikoFilter {
  const s = auswahlParam(sp, 's', SCHAEDEN);
  const w = auswahlParam(sp, 'w', WAHRSCHEINLICHKEITEN);
  const zelle = s !== '' && w !== '';
  return {
    gruppe: auswahlParam(sp, 'gruppe', RISIKO_GRUPPEN),
    gt: auswahlParam(sp, 'gt', GOVERNANCE_TYPEN),
    klasse: auswahlParam(sp, 'klasse', KLASSEN),
    appetit: ja(sp, 'appetit'),
    uebersteuert: ja(sp, 'uebersteuert'),
    kern: ja(sp, 'kern'),
    neu: ja(sp, 'neu'),
    s: zelle ? s : '',
    w: zelle ? w : '',
  };
}

/** Geprüfte Filterwerte als Query-Parameter (für Links, die die Filter erhalten). */
export function risikoFilterParameter(f: RisikoFilter): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.gruppe) p.gruppe = f.gruppe;
  if (f.gt) p.gt = f.gt;
  if (f.klasse) p.klasse = f.klasse;
  if (f.appetit) p.appetit = '1';
  if (f.uebersteuert) p.uebersteuert = '1';
  if (f.kern) p.kern = '1';
  if (f.neu) p.neu = '1';
  if (f.s && f.w) {
    p.s = f.s;
    p.w = f.w;
  }
  return p;
}

export function risikoFilterAktiv(f: RisikoFilter): boolean {
  return Object.keys(risikoFilterParameter(f)).length > 0;
}

/**
 * Auswahl und Reihenfolge wie in der Demo: über Appetit zuerst, dann
 * Bruttoklasse, Netto (Betrieb), Code. Alle Werte stammen aus der Antwort.
 */
export function filtereRisiken(
  risiken: readonly RisikoEintrag[],
  f: RisikoFilter,
): RisikoEintrag[] {
  return risiken
    .filter((r) => !f.gruppe || r.gruppe === f.gruppe)
    .filter((r) => !f.gt || r.gt === f.gt)
    .filter((r) => !f.klasse || r.bewertung.brutto.klasse === f.klasse)
    .filter((r) => !f.appetit || r.ueberAppetit)
    .filter(
      (r) =>
        !f.uebersteuert ||
        r.bewertung.uebersteuertDesign ||
        r.bewertung.uebersteuertBetrieb ||
        r.uebersteuerungen.some((u) => u.status === 'BEANTRAGT'),
    )
    .filter((r) => !f.kern || r.kern)
    .filter((r) => !f.neu || r.hinweise.length > 0)
    .filter((r) => !(f.s && f.w) || (r.s === f.s && r.w === f.w))
    .sort(
      (a, b) =>
        Number(b.ueberAppetit) - Number(a.ueberAppetit) ||
        KLASSE_RANG[b.bewertung.brutto.klasse] - KLASSE_RANG[a.bewertung.brutto.klasse] ||
        KLASSE_RANG[b.bewertung.wirksamBetrieb] - KLASSE_RANG[a.bewertung.wirksamBetrieb] ||
        a.code.localeCompare(b.code),
    );
}
