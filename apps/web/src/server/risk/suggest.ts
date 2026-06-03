// =============================================================================
// Heuristische Markierungs-Vorschläge für ein Rechercheergebnis (DB-frei → in
// der Seite in-memory nutzbar UND unit-testbar). Stärkstes Signal: gemeinsame
// Normanker (§-Zitate); zusätzlich Begriff-Erwähnung.
// =============================================================================

export interface MarkingSuggestion {
  markingId: string;
  begriff: string;
  score: number;
  reason: string;
}

/** Nur die für das Scoring nötigen Marking-Felder. */
export interface ScoreableMarking {
  id: string;
  begriff: string;
  normAnker: string[];
  status: string;
}

/** §-Zitate aus einem Text extrahieren (für die Normanker-Heuristik). */
export function extractNormRefs(text: string): string[] {
  const out = new Set<string>();
  const re = /§+\s?\d+[a-z]?(?:\s?Abs\.?\s?\d+)?(?:\s?(?:S\.|Satz)\s?\d+)?\s?[A-ZÄÖÜ][A-Za-zÄÖÜ]{1,6}/g;
  for (const m of text.matchAll(re)) out.add(m[0].replace(/\s+/g, ' ').trim());
  return [...out];
}

/**
 * Bewertet OFFENE/in-Prüfung-Markierungen gegen ein Ergebnis. Reine Funktion —
 * der Aufrufer liefert die (bereits geladenen) Markierungen, kein DB-Zugriff.
 * Liefert die Top-3 mit Score > 0.
 */
export function scoreMarkingSuggestions(
  result: { title?: string | null; body: string },
  markings: ScoreableMarking[],
): MarkingSuggestion[] {
  const full = `${result.title ?? ''}\n${result.body}`;
  const text = full.toLowerCase();
  const refs = extractNormRefs(full).map((r) => r.toLowerCase());

  const scored: MarkingSuggestion[] = [];
  for (const m of markings) {
    if (m.status !== 'OFFEN' && m.status !== 'IN_PRUEFUNG') continue;
    const ankerLower = m.normAnker.map((a) => a.toLowerCase());
    const normOverlap = ankerLower.filter((a) => refs.some((r) => r.includes(a) || a.includes(r))).length;
    const begriffHit = m.begriff && text.includes(m.begriff.toLowerCase()) ? 1 : 0;
    const score = normOverlap * 3 + begriffHit * 2;
    if (score > 0) {
      const reasons: string[] = [];
      if (normOverlap > 0) reasons.push(`${normOverlap} gemeinsame Normanker`);
      if (begriffHit) reasons.push('Begriff erwähnt');
      scored.push({ markingId: m.id, begriff: m.begriff, score, reason: reasons.join(' · ') });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}
