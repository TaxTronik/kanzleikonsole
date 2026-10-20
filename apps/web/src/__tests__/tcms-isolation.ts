// =============================================================================
// Prüfhilfen für die Richtungsisolation der Tax-CMS-Texte (kk-tcms-qual).
//
// `markiert` setzt an den Anfang und das Ende jedes Freitexts einer Antwort
// des Dienstes die Richtungsmarke RLM (U+200F; vom Vertrag erlaubt) und prüft
// das Ergebnis erneut mit dem Antwortschema. `nichtIsoliert` sucht im
// gerenderten DOM jeden Textknoten mit dieser Marke, der weder in `<bdi>` noch
// unter einem Element mit `dir`-Attribut steht – genau dort würde die Marke die
// umgebende Anzeige umordnen.
// =============================================================================

import { expect } from 'vitest';
import type { z } from 'zod';

export const MARKE = '‏';

/** Felder, die immer Freitext tragen, auch ohne Leerzeichen. */
const TEXTFELDER = new Set([
  'titel',
  'name',
  'dateiname',
  'text',
  'beschreibung',
  'begruendung',
  'kommentar',
  'sachverhalt',
  'erklaerung',
  'grund',
  'label',
  'bezeichnung',
  'funktion',
  'rechtsform',
  'anmerkung',
  'notiz',
]);

/** Werte, die keine Texte sind: IDs, Codes, Datumsangaben, Hashes, Schlüssel. */
function istKennung(wert: string): boolean {
  return (
    wert === '' ||
    /^[A-Z0-9_]+$/.test(wert) ||
    /^[A-Z0-9][A-Z0-9.-]*$/.test(wert) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wert) ||
    /^c[a-z0-9]{20,}$/.test(wert) ||
    /^\d{4}-\d{2}(-\d{2})?/.test(wert) ||
    /^[0-9a-f]{32,}$/i.test(wert) ||
    /^[\w.+-]+@[\w.-]+$/.test(wert) ||
    /^(https?:|\/)/.test(wert) ||
    /^[a-z][a-zA-Z0-9-]*$/.test(wert)
  );
}

function istText(schluessel: string | number | undefined, wert: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(wert) || /^\d{4}-\d{2}-\d{2}/.test(wert)) return false;
  if (typeof schluessel === 'string' && TEXTFELDER.has(schluessel)) return wert !== '';
  return !istKennung(wert) && /\s|\P{ASCII}/u.test(wert);
}

type Pfad = Array<string | number>;

function markiere(
  wert: unknown,
  schluessel: string | number | undefined,
  pfad: Pfad,
  alle: Pfad[],
): unknown {
  if (typeof wert === 'string') {
    if (!istText(schluessel, wert)) return wert;
    alle.push(pfad);
    return `${MARKE}${wert}${MARKE}`;
  }
  if (Array.isArray(wert)) return wert.map((w, i) => markiere(w, i, [...pfad, i], alle));
  if (wert !== null && typeof wert === 'object') {
    return Object.fromEntries(
      Object.entries(wert).map(([k, w]) => [k, markiere(w, k, [...pfad, k], alle)]),
    );
  }
  return wert;
}

function setze(ziel: unknown, pfad: Pfad, wert: unknown): void {
  let k = ziel as Record<string | number, unknown>;
  for (const teil of pfad.slice(0, -1)) k = k[teil] as Record<string | number, unknown>;
  k[pfad[pfad.length - 1]!] = wert;
}

function lies(quelle: unknown, pfad: Pfad): unknown {
  return pfad.reduce<unknown>((k, teil) => (k as Record<string | number, unknown>)[teil], quelle);
}

/**
 * Kopie von `daten` mit RLM an Anfang und Ende jedes Freitexts. Mit `schema`
 * bleiben Felder unmarkiert, deren Muster die Marke nicht zulässt (Codes,
 * Aufzählungen); das Ergebnis ist eine gültige Antwort des Vertrags.
 */
export function markiert<T>(daten: T, schema?: z.ZodType): T {
  const pfade: Pfad[] = [];
  const ergebnis = markiere(daten, undefined, [], pfade) as T;
  if (!schema) return ergebnis;
  for (let runde = 0; runde < 20; runde++) {
    const geprueft = schema.safeParse(ergebnis);
    if (geprueft.success) return geprueft.data as T;
    for (const fehler of geprueft.error.issues) {
      const pfad = fehler.path as Pfad;
      if (pfad.length > 0) setze(ergebnis, pfad, lies(daten, pfad));
    }
  }
  throw new Error('markierte Antwort passt nicht zum Schema');
}

function beschreibe(element: Element | null, wurzel: Element): string {
  const teile: string[] = [];
  for (let e = element; e && e !== wurzel; e = e.parentElement) {
    teile.unshift(e.tagName.toLowerCase());
  }
  return teile.slice(-4).join('>');
}

/** Textknoten mit Marke außerhalb von `<bdi>` und `[dir]` (mit DOM-Pfad). */
export function nichtIsoliert(wurzel: Element): { offen: string[]; gefunden: number } {
  const offen: string[] = [];
  let gefunden = 0;
  const gang = wurzel.ownerDocument.createTreeWalker(wurzel, 4 /* NodeFilter.SHOW_TEXT */);
  for (let knoten = gang.nextNode(); knoten; knoten = gang.nextNode()) {
    const text = knoten.textContent ?? '';
    if (!text.includes(MARKE)) continue;
    gefunden++;
    let isoliert = false;
    for (let e = knoten.parentElement; e; e = e.parentElement) {
      if (e.tagName === 'BDI' || e.hasAttribute('dir')) {
        isoliert = true;
        break;
      }
      if (e === wurzel) break;
    }
    if (!isoliert) {
      offen.push(
        `${beschreibe(knoten.parentElement, wurzel)}: ${text.replaceAll(MARKE, '‹RLM›').slice(0, 80)}`,
      );
    }
  }
  return { offen, gefunden };
}

/** Erwartet, dass jeder markierte Text isoliert ist und mindestens `mindestens` vorkommen. */
export function erwarteIsoliert(wurzel: Element, mindestens = 1): void {
  const { offen, gefunden } = nichtIsoliert(wurzel);
  expect(gefunden, 'markierte Texte im DOM (sonst prüft der Test nichts)').toBeGreaterThanOrEqual(
    mindestens,
  );
  expect(offen, 'Texte aus dem Tax-CMS ohne <bdi>/dir="auto"').toEqual([]);
}
