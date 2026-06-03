// =============================================================================
// Engine-Markierung (RiskMarkingInput) → Prisma-Create-Felder. EINE Quelle für
// saveAnalysis (neue Analyse) und reanalyze (Merge-Append) — tenantId/analysisId
// setzt der Aufrufer (geschachteltes create vs. createMany).
// =============================================================================

import type { RiskMarkingInput } from '@taxtronik/risk-layer';

/** Dedup-Schlüssel: dieselbe Stelle + Herkunft + Begriff = dieselbe Markierung. */
export const markingKey = (m: { start: number; end: number; herkunft: string; begriff: string }) =>
  `${m.start}:${m.end}:${m.herkunft}:${m.begriff}`;

export function markingCreateFields(m: RiskMarkingInput) {
  return {
    start: m.start,
    end: m.end,
    matchedText: m.matchedText,
    herkunft: m.herkunft,
    begriffId: m.begriffId,
    begriff: m.begriff,
    normAnker: m.normAnker,
    // leer → SQL NULL (UI fällt auf normAnker-Zitate zurück).
    normRefs: m.normRefs.length > 0 ? (m.normRefs as object) : undefined,
    // undefined → SQL NULL (kein Json-null nötig).
    normketten: m.normketten === null ? undefined : (m.normketten as object),
    governanceTyp: m.governanceTyp,
    schadensintensitaet: m.schadensintensitaet,
    wahrscheinlichkeit: m.wahrscheinlichkeit,
    kaskadenreichweite: m.kaskadenreichweite,
    engineStatus: m.engineStatus,
    streitig: m.streitig,
  };
}
