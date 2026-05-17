import type { ProtectionTier } from '@taxtronik/storage';

/**
 * Die `document.classification`-Spalte ist NOT NULL (Enum) und wird von
 * Altcode (Exporte, Filter) gelesen. Eigene Typen haben keinen Enum-Wert —
 * wir hinterlegen daher einen „Carrier", der die Schutzstufe korrekt
 * widerspiegelt. Anzeige läuft über documentType.name, die Compliance über
 * die Stufe.
 */
export function carrierClassification(
  tier: ProtectionTier,
  classificationKey: string | null,
): string {
  if (classificationKey) return classificationKey; // Kern-Typ → exakter Enum
  switch (tier) {
    case 'GOBD':
      return 'GOBD_TAX';
    case 'GWG':
      return 'GWG_EVIDENCE';
    default:
      return 'GENERAL';
  }
}
