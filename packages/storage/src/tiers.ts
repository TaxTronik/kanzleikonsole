// =============================================================================
// Schutzstufen (iter55) — rein, ohne S3-Client und ohne ENV-Validierung, damit
// Web-UI und Client-Bundles dieselbe Regel nutzen können (Review-Befund R-14:
// vorher drei Ableitungen, eine davon markierte GwG-Belege als GoBD).
// Die Stufe — nicht die rohe Klassifikation — treibt Bucket, Object-Lock und
// Aufbewahrung. Genau drei, fix.
// =============================================================================

export type ProtectionTier = 'NONE' | 'GWG' | 'GOBD';

const GOBD_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'GOBD_INVOICE',
  'GOBD_CONTRACT',
  'GOBD_TAX',
]);

export function isGobdClassification(classification: string): boolean {
  // B-1: GWG_EVIDENCE BEWUSST NICHT mehr GoBD-pflichtig markiert. Vorher
  // landete GWG_EVIDENCE im gobd-Bucket mit 10-Jahre-COMPLIANCE-Lock, was
  // eine fachliche Vernichtung nach § 8 Abs. 4 GwG verhindern konnte.
  return GOBD_CLASSIFICATIONS.has(classification);
}

/**
 * B-1: GwG-Klassifikation mit fünfjähriger technischer Grundbarriere. Das
 * tatsächliche Ende wird fachlich geprüft (längere Gesetze; spätestens 10 J.).
 */
export function isGwgClassification(classification: string): boolean {
  return classification === 'GWG_EVIDENCE';
}

/** Gesetzlich fixes Mapping der 7 Kern-Typen → Schutzstufe (Back-Compat /
 *  Altbestand ohne documentType). */
export function classificationToTier(classification: string): ProtectionTier {
  if (isGobdClassification(classification)) return 'GOBD';
  if (isGwgClassification(classification)) return 'GWG';
  return 'NONE';
}

/**
 * Schutzstufe eines Dokuments: aus dem Dokumenttyp, für Altbestände ohne Typ
 * aus der Klassifikation.
 */
export function documentTier(
  classification: string,
  typeTier: ProtectionTier | null | undefined,
): ProtectionTier {
  return typeTier ?? classificationToTier(classification);
}
