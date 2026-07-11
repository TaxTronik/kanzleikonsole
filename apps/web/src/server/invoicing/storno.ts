// =============================================================================
// Fachliche Abbildung einer Originalposition auf eine Storno-/Korrekturposition.
//
// EN 16931 BR-27 verbietet negative Artikel-Nettopreise (BT-146). Eine negative
// Rechnungszeile wird deshalb mit positivem Preis und negativer Menge abgebildet.
// Der Altbestands-Fall eines bereits negativen Originalpreises wird ebenfalls
// normalisiert: Die Korrektur kehrt dann das Vorzeichen der Menge passend um.
// =============================================================================

export interface StornoSourcePosition {
  position: number;
  description: string;
  quantity: number | { toString(): string };
  unitPrice: number | { toString(): string };
  unit: string;
  netAmount: number | { toString(): string };
  vatRate: number | { toString(): string };
}

export interface StornoPosition {
  position: number;
  description: string;
  quantity: number;
  unitPrice: number;
  unit: string;
  netAmount: number;
  vatRate: number;
}

export function toStornoPosition(position: StornoSourcePosition): StornoPosition {
  const originalQuantity = Number(position.quantity.toString());
  const originalUnitPrice = Number(position.unitPrice.toString());
  return {
    position: position.position,
    description: position.description,
    // Normalfall: positive Originalmenge → negative Korrekturmenge. Falls ein
    // Altbeleg einen unzulässig negativen Preis enthält, wird der Preis positiv
    // und die Menge positiv; das Zeilenvorzeichen wird trotzdem exakt invertiert.
    quantity: originalUnitPrice < 0 ? originalQuantity : -originalQuantity,
    unitPrice: Math.abs(originalUnitPrice),
    unit: position.unit,
    netAmount: -Number(position.netAmount.toString()),
    vatRate: Number(position.vatRate.toString()),
  };
}
