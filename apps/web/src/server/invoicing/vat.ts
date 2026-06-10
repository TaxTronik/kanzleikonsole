// =============================================================================
// USt je Position (iter86) — Gruppierung und Summenbildung.
//
// § 14 Abs. 4 Nr. 8 UStG verlangt den Ausweis des Entgelts AUFGESCHLÜSSELT
// nach Steuersätzen. Der Steuersatz lebt deshalb an der Position; Kopf-Summen
// und der E-Rechnungs-Steuerblock werden je Satz gruppiert gebildet.
// Rundung: USt je Satz-Gruppe auf 2 Stellen (nicht je Position — sonst
// akkumulieren Rundungsdifferenzen), Gesamt = Summe der Gruppen.
//
// EN-16931-Kategorie: Satz > 0 → "S" (Standard), Satz = 0 → "Z" (zero rated).
// Befreite Umsätze mit Befreiungsgrund (Kategorie "E") sind bewusst nicht
// abgebildet (Kanzlei-Praxis: Regelsteuersatz; 0 % als Randfall).
// =============================================================================

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

/** EN-16931-Steuerkategorie für einen Satz (s. Kopfkommentar). */
export function vatCategory(rate: number): 'S' | 'Z' {
  return rate > 0 ? 'S' : 'Z';
}
