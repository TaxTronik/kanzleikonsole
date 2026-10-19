// =============================================================================
// Manuelle Prüflast je Mandant und Monat, getrennt nach FP, FF und IN.
// Gezählt werden Durchführungen mit Fälligkeit im Monat (ohne entfallene);
// außerplanmäßige (Auslösungen) separat. Keine Personen-Kennzahlen.
// =============================================================================

import type { GovernanceTyp } from './types';
import { monatSchluessel } from './perioden';

export interface DurchfuehrungFuerLast {
  faelligAm: Date;
  gt: GovernanceTyp | null;
  ausserplanmaessig: boolean;
  entfallen: boolean;
}

export interface Pruflast {
  monat: string;
  FP: number;
  FF: number;
  IN: number;
  ausloesungen: number;
  gesamt: number;
}

export function pruflast(
  durchfuehrungen: readonly DurchfuehrungFuerLast[],
  monat: string,
): Pruflast {
  const last: Pruflast = { monat, FP: 0, FF: 0, IN: 0, ausloesungen: 0, gesamt: 0 };
  for (const d of durchfuehrungen) {
    if (d.entfallen || monatSchluessel(d.faelligAm) !== monat) continue;
    if (d.ausserplanmaessig) {
      last.ausloesungen++;
    } else {
      last[d.gt ?? 'FP']++;
    }
    last.gesamt++;
  }
  return last;
}
