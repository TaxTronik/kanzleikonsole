// =============================================================================
// Anzeigehelfer des Länder-Monitors (TCMS Stufe 3, Demo components/laender/*).
// Ohne I/O. Registrierungsstatus und Schwelle berechnet der Dienst; hier
// stehen nur Labels, das Lesen des Geschäftsprofils (ungetypt im Vertrag,
// deshalb mit Typprüfung) und der Vergleich zweier Stände für die Historie.
// =============================================================================

import type { LandStand } from '@taxtronik/tcms-contract';
import { fmtEurGanz, fmtMonatJahr } from '@taxtronik/tcms-domain';
import { isoDatumText } from '../format';
import type { BadgeKlasse } from '../ton';

export type Registrierung = LandStand['registrierung'];

export const REG_BADGE: Readonly<Record<Registrierung, BadgeKlasse>> = {
  VOLLSTAENDIG: 'badge-green',
  FEHLT: 'badge-red',
  PRUEFEN: 'badge-yellow',
};

export const REG_LABEL: Readonly<Record<Registrierung, string>> = {
  VOLLSTAENDIG: 'vollständig',
  FEHLT: 'fehlt',
  PRUEFEN: 'Steuersätze prüfen',
};

export const REG_LANG: Readonly<Record<Registrierung, string>> = {
  VOLLSTAENDIG: 'Registrierung vollständig',
  FEHLT: 'Registrierung fehlt',
  PRUEFEN: 'Steuersätze prüfen',
};

type Profil = Record<string, unknown> | null;

function objekt(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

/** Lagerart laut Geschäftsprofil (P2) für ein Land, sonst null. */
export function lagerArt(profil: Profil, land: string): string | null {
  const lager = objekt(objekt(profil)?.['p2'])?.['lager'];
  if (!Array.isArray(lager)) return null;
  const eintrag = lager.map(objekt).find((x) => x?.['land'] === land);
  const art = eintrag?.['art'];
  return typeof art === 'string' ? art : null;
}

/** Lokale USt-Nummern und OSS-Beginn laut Geschäftsprofil (P9). */
export function profilP9(profil: Profil): { lokaleUstNr: string[]; ossSeit: string | null } {
  const p9 = objekt(objekt(profil)?.['p9']);
  const lokal = p9?.['lokaleUstNr'];
  const oss = p9?.['ossSeit'];
  return {
    lokaleUstNr: Array.isArray(lokal)
      ? lokal.filter((x): x is string => typeof x === 'string')
      : [],
    ossSeit: typeof oss === 'string' ? oss : null,
  };
}

/** Verkaufskanäle laut Geschäftsprofil (P1). */
export function profilKanaele(profil: Profil): string[] {
  const p1 = objekt(objekt(profil)?.['p1']);
  if (!p1) return [];
  const kanaele: string[] = [];
  if (p1['eigenerShop'] === true) {
    const system =
      typeof p1['shopSystem'] === 'string' && p1['shopSystem'] ? ` (${p1['shopSystem']})` : '';
    kanaele.push(`eigener Shop${system}`);
  }
  const markt = p1['marktplaetze'];
  if (Array.isArray(markt))
    kanaele.push(...markt.filter((x): x is string => typeof x === 'string'));
  return kanaele;
}

const ja = (b: boolean) => (b ? 'ja' : 'nein');

/** Unterschiede zweier aufeinanderfolgender Stände (Anzeige der Historie). */
export function standUnterschiede(alt: LandStand, neu: LandStand): string[] {
  const d: string[] = [];
  if (alt.fernverkaeufeLfdEur !== neu.fernverkaeufeLfdEur)
    d.push(
      `Fernverkäufe ${fmtEurGanz(alt.fernverkaeufeLfdEur)} → ${fmtEurGanz(neu.fernverkaeufeLfdEur)}`,
    );
  if (alt.fernverkaeufeVorjahrEur !== neu.fernverkaeufeVorjahrEur)
    d.push(
      `Vorjahr ${fmtEurGanz(alt.fernverkaeufeVorjahrEur)} → ${fmtEurGanz(neu.fernverkaeufeVorjahrEur)}`,
    );
  if (alt.lagerSeit !== neu.lagerSeit)
    d.push(
      `Lager seit ${alt.lagerSeit ? fmtMonatJahr(alt.lagerSeit) : '–'} → ${neu.lagerSeit ? fmtMonatJahr(neu.lagerSeit) : '–'}`,
    );
  if (alt.oss !== neu.oss) d.push(`OSS ${ja(alt.oss)} → ${ja(neu.oss)}`);
  if (alt.lokaleUstNr !== neu.lokaleUstNr)
    d.push(`lokale USt-Nr. ${ja(alt.lokaleUstNr)} → ${ja(neu.lokaleUstNr)}`);
  if (alt.zmRelevant !== neu.zmRelevant)
    d.push(`ZM-relevant ${ja(alt.zmRelevant)} → ${ja(neu.zmRelevant)}`);
  if (alt.steuersaetzeGeprueftAm !== neu.steuersaetzeGeprueftAm)
    d.push(
      `Steuersätze geprüft ${isoDatumText(alt.steuersaetzeGeprueftAm)} → ${isoDatumText(neu.steuersaetzeGeprueftAm)}`,
    );
  if (alt.registrierung !== neu.registrierung)
    d.push(`Status ${REG_LABEL[alt.registrierung]} → ${REG_LABEL[neu.registrierung]}`);
  return d;
}
