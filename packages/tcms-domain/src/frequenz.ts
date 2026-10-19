// =============================================================================
// Kontrollhäufigkeit aus Governance-Typ × Bruttoklasse (Fachkonzept Abschnitt 6).
//
// Der Governance-Typ legt den Kontrollzyklus fest, die Bruttoklasse die Dichte.
// Maßgeblich ist die Bruttoklasse, weil die Nettoklasse selbst von den
// Kontrollen abhängt. Hängt eine Kontrolle an mehreren Risiken, gilt die
// strengste Frequenz; die effektive Frequenz ist die strengere aus Vorlage
// und Matrix.
// =============================================================================

import type { GovernanceTyp, Klasse } from './types';

export type Turnus = 'KEIN' | 'JAEHRLICH' | 'QUARTALSWEISE' | 'MONATLICH';

export interface Frequenz {
  turnus: Turnus;
  /** Zusätzlich manuelle Prüfung bei jeder Auslösung (Ereignis). */
  anlass: boolean;
}

export const TURNUS_PRO_JAHR: Record<Turnus, number> = {
  KEIN: 0,
  JAEHRLICH: 1,
  QUARTALSWEISE: 4,
  MONATLICH: 12,
};

export const TURNUS_LABEL: Record<Turnus, string> = {
  KEIN: '—',
  JAEHRLICH: 'jährlich',
  QUARTALSWEISE: 'quartalsweise',
  MONATLICH: 'monatlich',
};

export function frequenzLabel(f: Frequenz): string {
  if (f.turnus === 'KEIN') return f.anlass ? 'nur bei Auslösung' : '—';
  const basis = TURNUS_LABEL[f.turnus];
  return f.anlass ? `${basis} + bei Auslösung` : basis;
}

export function gleicheFrequenz(a: Frequenz, b: Frequenz): boolean {
  return a.turnus === b.turnus && a.anlass === b.anlass;
}

/** Die strengere zweier Frequenzen (höherer Turnus, Anlass als Oder). */
export function strengere(a: Frequenz, b: Frequenz): Frequenz {
  const turnus = TURNUS_PRO_JAHR[a.turnus] >= TURNUS_PRO_JAHR[b.turnus] ? a.turnus : b.turnus;
  return { turnus, anlass: a.anlass || b.anlass };
}

/** true, wenn `a` mindestens so streng ist wie `b`. */
export function mindestensSoStreng(a: Frequenz, b: Frequenz): boolean {
  return TURNUS_PRO_JAHR[a.turnus] >= TURNUS_PRO_JAHR[b.turnus] && (a.anlass || !b.anlass);
}

/**
 * Häufigkeitsmatrix (Startwerte, vom Berufsträger zu kalibrieren).
 * `periode` ist der Erklärungsturnus des Mandanten für „jede Periode" (FP).
 */
export function matrixFrequenz(
  gt: GovernanceTyp,
  brutto: Klasse,
  periode: Turnus = 'MONATLICH',
): Frequenz {
  const hochOderKritisch = brutto === 'HOCH' || brutto === 'KRITISCH';
  switch (gt) {
    case 'FP':
      // „jede Periode", mindestens quartalsweise (nie seltener als FP · mittel).
      if (hochOderKritisch)
        return strengere(
          { turnus: periode, anlass: false },
          { turnus: 'QUARTALSWEISE', anlass: false },
        );
      if (brutto === 'MITTEL') return { turnus: 'QUARTALSWEISE', anlass: false };
      return { turnus: 'JAEHRLICH', anlass: false };
    case 'FF':
      if (hochOderKritisch) return { turnus: 'MONATLICH', anlass: true };
      if (brutto === 'MITTEL') return { turnus: 'QUARTALSWEISE', anlass: true };
      return { turnus: 'KEIN', anlass: true };
    case 'IN':
      if (brutto === 'GERING') return { turnus: 'KEIN', anlass: true };
      return { turnus: 'JAEHRLICH', anlass: true };
  }
}

export const MATRIX_ZEILEN: ReadonlyArray<{
  gt: GovernanceTyp;
  zyklus: string;
  hoch: string;
  mittel: string;
  gering: string;
}> = [
  {
    gt: 'FP',
    zyklus: 'periodisch an festen Zeitpunkten: Voranmeldung, OSS-Quartal, Jahresabschluss',
    hoch: 'jede Periode',
    mittel: 'quartalsweise',
    gering: 'jährlich',
  },
  {
    gt: 'FF',
    zyklus: 'laufendes Monitoring über Ereignisse; manuelle Prüfung bei jeder Auslösung',
    hoch: 'monatlich + jede Auslösung',
    mittel: 'quartalsweise + jede Auslösung',
    gering: 'jede Auslösung',
  },
  {
    gt: 'IN',
    zyklus: 'keine wiederkehrende Kontrolle; gegengezeichnete Risikoaufklärung (K-EC-24)',
    hoch: 'jährliche Bestätigung + bei Ereignis',
    mittel: 'jährliche Bestätigung + bei Ereignis',
    gering: 'bei Ereignis',
  },
];

export interface RisikoFuerFrequenz {
  code: string;
  gt: GovernanceTyp;
  brutto: Klasse;
}

const GT_VORRANG: Record<GovernanceTyp, number> = { FP: 3, FF: 2, IN: 1 };

export interface FrequenzAbleitung {
  /** Strengste Matrixfrequenz über alle verknüpften Risiken. */
  mindest: Frequenz;
  /** Strengere aus Vorlage und Matrix. */
  effektiv: Frequenz;
  /** Governance-Typ des Risikos, das die strengste Frequenz bestimmt. */
  gt: GovernanceTyp | null;
  /** Risiko, aus dem die Mindestfrequenz stammt. */
  quelle: RisikoFuerFrequenz | null;
  /** Effektive Frequenz weicht von der Vorlage ab (Matrix ist strenger). */
  abweichendVonVorlage: boolean;
  /** Kurzbegründung für Tooltips, z. B. „abgeleitet aus FF · kritisch (EC-UST-05)". */
  begruendung: string;
}

/**
 * „Jede Periode" einer Kontrolle: ihr eigener Erklärungsrhythmus, wenn die
 * Vorlage monatlich oder quartalsweise ist (z. B. OSS quartalsweise),
 * sonst der Erklärungsturnus des Mandanten.
 */
export function periodeFuer(vorlage: Frequenz, programmTurnus: Turnus): Turnus {
  return vorlage.turnus === 'MONATLICH' || vorlage.turnus === 'QUARTALSWEISE'
    ? vorlage.turnus
    : programmTurnus;
}

export function leiteFrequenzAb(
  vorlage: Frequenz,
  risiken: readonly RisikoFuerFrequenz[],
  programmTurnus: Turnus = 'MONATLICH',
): FrequenzAbleitung {
  const periode = periodeFuer(vorlage, programmTurnus);
  let mindest: Frequenz = { turnus: 'KEIN', anlass: false };
  let quelle: RisikoFuerFrequenz | null = null;
  for (const r of risiken) {
    const f = matrixFrequenz(r.gt, r.brutto, periode);
    const strenger =
      quelle === null ||
      TURNUS_PRO_JAHR[f.turnus] > TURNUS_PRO_JAHR[mindest.turnus] ||
      (TURNUS_PRO_JAHR[f.turnus] === TURNUS_PRO_JAHR[mindest.turnus] &&
        GT_VORRANG[r.gt] > GT_VORRANG[quelle.gt]);
    mindest = strengere(mindest, f);
    if (strenger) quelle = r;
  }
  const effektiv = strengere(vorlage, mindest);
  const abweichendVonVorlage = !gleicheFrequenz(effektiv, vorlage);
  const begruendung = quelle
    ? `abgeleitet aus ${quelle.gt} · ${quelle.brutto.toLowerCase()} (${quelle.code}); Vorlage: ${frequenzLabel(vorlage)}`
    : `keine verknüpften Risiken; Vorlage: ${frequenzLabel(vorlage)}`;
  return { mindest, effektiv, gt: quelle?.gt ?? null, quelle, abweichendVonVorlage, begruendung };
}
