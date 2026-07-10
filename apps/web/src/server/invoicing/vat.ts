// =============================================================================
// USt je Position (iter86) — Gruppierung und Summenbildung.
//
// § 14 Abs. 4 Nr. 8 UStG verlangt den Ausweis des Entgelts AUFGESCHLÜSSELT
// nach Steuersätzen. Der Steuersatz lebt deshalb an der Position; Kopf-Summen
// und der E-Rechnungs-Steuerblock werden je Satz gruppiert gebildet.
// Rundung: USt je Satz-Gruppe auf 2 Stellen (nicht je Position — sonst
// akkumulieren Rundungsdifferenzen), Gesamt = Summe der Gruppen.
//
// EN-16931-Kategorie: Satz > 0 → "S" (Standard); Satz = 0 MIT Befreiungsgrund →
// "E" (exempt, BT-120 Pflicht), ohne Grund → "Z" (zero rated).
// =============================================================================

import { round2 } from '@/lib/fmt';

export interface VatPosition {
  netAmount: number;
  vatRate: number;
}

export interface VatGroup {
  rate: number;
  net: number;
  vat: number;
}

export interface VatTotals {
  groups: VatGroup[];
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  /** Einheitlicher Satz aller Positionen — oder null bei Mischsätzen. */
  uniformRate: number | null;
}

/** Gruppiert Positionen nach Steuersatz und bildet die Kopf-Summen. */
export function computeVatTotals(positions: VatPosition[]): VatTotals {
  const byRate = new Map<number, number>();
  for (const p of positions) {
    byRate.set(p.vatRate, round2((byRate.get(p.vatRate) ?? 0) + p.netAmount));
  }
  const groups: VatGroup[] = [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, net]) => ({ rate, net, vat: round2((net * rate) / 100) }));

  const netAmount = round2(groups.reduce((s, g) => s + g.net, 0));
  const vatAmount = round2(groups.reduce((s, g) => s + g.vat, 0));
  return {
    groups,
    netAmount,
    vatAmount,
    totalAmount: round2(netAmount + vatAmount),
    uniformRate: groups.length === 1 ? (groups[0]?.rate ?? null) : null,
  };
}

/** EN-16931-Steuerkategorie für einen Satz (s. Kopfkommentar). Reverse-Charge
 *  (§ 13b UStG) → "AE" (Steuerschuldnerschaft des Leistungsempfängers, 0 %).
 *  Bei 0 % mit hinterlegtem Befreiungsgrund → "E" (steuerbefreit), sonst "Z".
 *  Satz > 0 → "S". */
export function vatCategory(
  rate: number,
  hasExemptionReason = false,
  reverseCharge = false,
): 'S' | 'Z' | 'E' | 'AE' {
  if (reverseCharge) return 'AE';
  if (rate > 0) return 'S';
  return hasExemptionReason ? 'E' : 'Z';
}
