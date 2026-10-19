// =============================================================================
// Freigaben des Tax-CMS: Bezeichnungen für Art, Status und Code-Status
// (TCMS Stufe 3, Bereich A; aus der Demo kommunikation/page.tsx). Feste Texte;
// den Status und ob eine Freigabe einen Code braucht, entscheidet der Dienst.
// =============================================================================

import type { FreigabeHistorieZeile } from '@taxtronik/tcms-contract';

export type FreigabeArt = FreigabeHistorieZeile['art'];

export const FREIGABE_ART_LABEL: Readonly<Record<FreigabeArt, string>> = {
  ZIELE: 'Compliance-Ziele',
  BESCHREIBUNG: 'CMS-Beschreibung',
  RISIKOAKZEPTANZ: 'Risikoakzeptanz',
  AUFKLAERUNG: 'Risikoaufklärung',
  KENNTNISNAHME: 'Kenntnisnahme',
};

export const FREIGABE_STATUS: Readonly<
  Record<FreigabeHistorieZeile['status'], { label: string; badge: string }>
> = {
  OFFEN: { label: 'offen', badge: 'badge-yellow' },
  FREIGEGEBEN: { label: 'erteilt', badge: 'badge-green' },
  // Der Dienst führt abgelehnte und zurückgezogene Anforderungen gleich; die Anmerkung nennt den Grund.
  ABGELEHNT: { label: 'beendet', badge: 'badge-gray' },
};

/** Zustand des Bestätigungscodes einer offenen Anforderung (nie der Code selbst). */
export function codeText(
  f: Pick<FreigabeHistorieZeile, 'art' | 'codeStatus' | 'codeAblauf'>,
  datum: (iso: string | null) => string,
): string {
  if (f.art === 'KENNTNISNAHME') return 'ohne Code';
  switch (f.codeStatus) {
    case 'AKTIV':
      return `Code gültig bis ${datum(f.codeAblauf)}`;
    case 'ABGELAUFEN':
      return 'Code abgelaufen';
    case 'GESPERRT':
      return 'Code gesperrt (zu viele Fehlversuche)';
    default:
      return 'noch kein Code angefordert';
  }
}
