// =============================================================================
// Pure Helfer: Kontext-Anker einer Markierung als Wiedervorlage-Notiz.
//
// Bewusst frei von DB-/Paket-Importen, damit ohne ENV/DB unit-testbar.
// =============================================================================

export interface DelegationMarkingContext {
  begriff: string;
  normAnker: string[];
  start: number;
  end: number;
  matchedText: string;
  analysisId: string;
  id: string;
  analysis: { documentId: string | null };
}

/** Baut die Wiedervorlage-Notiz mit allen Kontext-Ankern der Markierung. */
export function buildDelegationNotes(marking: DelegationMarkingContext, extra?: string): string {
  const lines: string[] = [`Begriff: ${marking.begriff}`];
  if (marking.normAnker.length > 0) lines.push(`Normanker: ${marking.normAnker.join(', ')}`);
  lines.push(`Fundstelle: Zeichen ${marking.start}–${marking.end} ("${marking.matchedText}")`);
  lines.push(`Analyse: ${marking.analysisId}`);
  lines.push(`Markierung: ${marking.id}`);
  if (marking.analysis.documentId) lines.push(`Dokument: ${marking.analysis.documentId}`);
  if (extra && extra.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}
