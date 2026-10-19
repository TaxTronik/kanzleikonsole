// =============================================================================
// Gemeinsame Hilfen der Seiten des Bereichs B (Risiken, Kontrollen, Kalender,
// Prüfung, Länder; TCMS Stufe 3): Query-Parameter lesen, Links mit
// erhaltenem Stichtag bauen, Sperrgrund aus den Kennzeichen des Dienstes.
//
// Nichts hiervon entscheidet fachlich: Ob ein Schritt erlaubt ist, prüft der
// Dienst bei jedem Aufruf. Die Sperre blendet nur Bedienelemente aus, die der
// Dienst nach seinen eigenen Kennzeichen (`historisch`, `rechte.bearbeiten`)
// ohnehin ablehnen würde (Leitfaden §1).
// =============================================================================

import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';

export type SuchParameter = Record<string, string | string[] | undefined>;

/** Erster Wert eines Query-Parameters (Mehrfachangaben zählen nicht). */
export function param(sp: SuchParameter, name: string): string {
  const wert = sp[name];
  return (Array.isArray(wert) ? wert[0] : wert) ?? '';
}

/** ID eines Tax-CMS-Objekts wie im Vertrag (`ObjektIdSchema`): 1–64 Zeichen `A-Z a-z 0-9 _ -`. */
const OBJEKT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Objekt-ID aus der Query nur in gültiger Form, sonst `null` (kein Aufruf mit Fremdeingaben). */
export function objektIdParam(sp: SuchParameter, name: string): string | null {
  const wert = param(sp, name);
  return OBJEKT_ID.test(wert) ? wert : null;
}

/** Wert aus einer festen Auswahl, sonst `''`. */
export function auswahlParam<T extends string>(
  sp: SuchParameter,
  name: string,
  erlaubt: readonly T[],
): T | '' {
  const wert = param(sp, name);
  return (erlaubt as readonly string[]).includes(wert) ? (wert as T) : '';
}

/**
 * Link auf `pfad` mit den Parametern `behalten` (bereits geprüfte Werte der
 * Seite) und den Änderungen; leere Werte entfallen. Rohwerte der Query werden
 * nie ungeprüft weitergereicht.
 */
export function seitenLink(
  pfad: string,
  behalten: Readonly<Record<string, string | null | undefined>>,
  aenderung: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const q = new URLSearchParams();
  for (const [name, wert] of Object.entries({ ...behalten, ...aenderung })) {
    if (wert) q.set(name, wert);
  }
  const text = q.toString();
  return text ? `${pfad}?${text}` : pfad;
}

/** Stichtag für Links: nur bei historischem Stand (wie im Cockpit). */
export function standFuerLinks(antwort: { historisch: boolean; stand: string }): string | null {
  return antwort.historisch ? antwort.stand : null;
}

/** Hängt einen historischen Stichtag an einen Link an. */
export function mitStand(href: string, stand: string | null): string {
  if (!stand) return href;
  return `${href}${href.includes('?') ? '&' : '?'}stand=${stand}`;
}

export const NUR_AKTUELL = 'Historischer Stand – Änderungen sind nur am aktuellen Stand möglich.';

/**
 * Sperrgrund für schreibende Bedienelemente aus den Kennzeichen des Dienstes:
 * historischer Stand oder kein Bearbeitungsrecht (`rechte.bearbeiten` des
 * Kontexts). `null`: Bedienelemente anbieten – entscheiden wird der Dienst.
 */
export function sperreAus(kontext: {
  historisch: boolean;
  rechte: { bearbeiten: boolean };
}): string | null {
  if (kontext.historisch) return NUR_AKTUELL;
  if (!kontext.rechte.bearbeiten) return TCMS_KEIN_RECHT.BEARBEITEN;
  return null;
}

/**
 * Vier-Augen-Anzeige: Hat die angemeldete Person selbst beantragt bzw.
 * eingereicht, bietet die Oberfläche ihr die Entscheidung nicht an. Der
 * Dienst prüft dasselbe bei jedem Aufruf (`zweitePerson`); diese Auswahl
 * ersetzt seine Prüfung nicht.
 */
export function selbstBeantragt(personId: string | null | undefined, antrag: string | null) {
  return !!personId && !!antrag && personId.toLowerCase() === antrag.toLowerCase();
}
