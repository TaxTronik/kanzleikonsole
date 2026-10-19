// =============================================================================
// Feste Texte und Anzeigeauswahlen des Ereigniseingangs und der Portal-
// Meldungen (TCMS Stufe 3, Bereich D; aus der Demo server/ereignisse-daten.ts).
// Labels der Domain (@taxtronik/tcms-domain) haben Vorrang; hier steht nur,
// was die Domain nicht führt. Badge-Klassen nur aus ../ton.ts.
// =============================================================================

import {
  EREIGNIS_QUELLE_LABEL,
  EREIGNISTYPEN,
  ereignistyp,
  PORTAL_SONSTIGES,
  type EreignisQuelle,
  type EreignisStatus,
  type FolgeStatus,
} from '@taxtronik/tcms-domain';
import type { BadgeKlasse } from '../ton';

export const FOLGE_STATUS_LABEL: Readonly<Record<FolgeStatus, string>> = {
  VORGESCHLAGEN: 'vorgeschlagen',
  ANGELEGT: 'angelegt',
  ERLEDIGT: 'erledigt',
  VERWORFEN: 'verworfen',
};

export const FOLGE_STATUS_BADGE: Readonly<Record<FolgeStatus, BadgeKlasse>> = {
  VORGESCHLAGEN: 'badge-gray',
  ANGELEGT: 'badge-brand',
  ERLEDIGT: 'badge-green',
  VERWORFEN: 'badge-gray',
};

/** Portal-Sprache (Sie-Form, ohne interne Begriffe). */
export const PORTAL_MELDUNG_STATUS_LABEL: Readonly<Record<EreignisStatus, string>> = {
  NEU: 'eingegangen',
  IN_TRIAGE: 'in Prüfung bei der Kanzlei',
  ERLEDIGT: 'erledigt',
  VERWORFEN: 'geprüft – keine Folgen',
};

export function quelleText(quelle: EreignisQuelle): string {
  return quelle === 'MANUELL' ? 'Kanzlei (manuell)' : EREIGNIS_QUELLE_LABEL[quelle];
}

export interface TypInfo {
  code: string;
  titel: string;
  icon: string;
  ton: string;
}

/** Anzeigeangaben eines Ereignistyps, auch für „Sonstiges“ (ohne Katalogtyp). */
export function typInfo(code: string): TypInfo {
  const t = ereignistyp(code);
  if (t) return { code: t.code, titel: t.titel, icon: t.icon, ton: t.ton };
  return {
    code: PORTAL_SONSTIGES.code,
    titel: PORTAL_SONSTIGES.titel,
    icon: PORTAL_SONSTIGES.icon,
    ton: PORTAL_SONSTIGES.ton,
  };
}

/** Bezeichnung des Typs in Listen: Code bzw. „Sonstiges“. */
export function typKurz(code: string): string {
  return code === 'SONST' ? 'Sonstiges' : code;
}

export interface MeldeKachel {
  code: string;
  label: string;
  icon: string;
  ton: string;
}

/** Im Portal meldbare Ereignistypen in Katalogreihenfolge, zuletzt „Sonstiges“. */
export const PORTAL_KACHELN: readonly MeldeKachel[] = [
  ...EREIGNISTYPEN.filter((t) => t.portal).map((t) => ({
    code: t.code,
    label: t.portalLabel ?? t.titel,
    icon: t.icon,
    ton: t.ton,
  })),
  {
    code: PORTAL_SONSTIGES.code,
    label: PORTAL_SONSTIGES.titel,
    icon: PORTAL_SONSTIGES.icon,
    ton: PORTAL_SONSTIGES.ton,
  },
];

/** Quellen, die die Kanzlei beim Erfassen wählen kann (Vertrag: ohne PORTAL). */
export const KANZLEI_QUELLEN = ['MANUELL', 'KONTROLLE', 'STAMMDATEN', 'RSS'] as const;
