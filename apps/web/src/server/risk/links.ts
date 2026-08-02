// =============================================================================
// Sprungziele in den Subsumtions-Space.
//
// Eine Zuweisung soll den Empfaenger nicht auf der Mandantenseite abliefern,
// sondern an der Markierung, um die es geht. Der Query-Parameter waehlt sie im
// Workspace vor.
// =============================================================================

export const SUBSUMTION_MARKING_PARAM = 'marking';

export function subsumtionAnalysisHref(clientId: string, analysisId: string): string {
  return `/staff/clients/${clientId}/subsumtion/${analysisId}`;
}

export function subsumtionMarkingHref(
  clientId: string,
  analysisId: string,
  markingId: string,
): string {
  return `${subsumtionAnalysisHref(clientId, analysisId)}?${SUBSUMTION_MARKING_PARAM}=${markingId}`;
}
