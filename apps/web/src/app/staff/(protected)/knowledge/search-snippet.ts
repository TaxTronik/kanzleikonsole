// =============================================================================
// Suchtreffer-Ausschnitt der Wissensdatenbank als Textsegmente.
//
// ts_headline escapet den Artikeltext nicht, es setzt nur die Trenner aus
// StartSel/StopSel um Treffer. Statt daraus HTML zu bauen, zerlegt
// parseSearchSnippet den Ausschnitt in Klartextsegmente. Die Seite rendert sie
// als React-Textknoten und <mark>-Elemente; Artikeltext gelangt nie als HTML
// ins DOM (Stored-XSS-Schutz, früher C1 per Escape + Rückwandlung).
// =============================================================================

/** Trenner für ts_headline; müssen zu den Optionen der Suchabfrage passen. */
export const SNIPPET_START_SEL = '<mark>';
export const SNIPPET_STOP_SEL = '</mark>';

export interface SnippetSegment {
  text: string;
  /** true: Suchtreffer, wird hervorgehoben. */
  mark: boolean;
}

const SELECTOR = /(<mark>|<\/mark>)/;

/**
 * Zerlegt die ts_headline-Ausgabe in Text- und Treffersegmente. Ein im
 * Artikeltext wörtlich stehendes `<mark>` schaltet nur die Hervorhebung um;
 * jeder andere Inhalt bleibt Text.
 */
export function parseSearchSnippet(raw: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let mark = false;
  for (const part of raw.split(SELECTOR)) {
    if (part === SNIPPET_START_SEL || part === SNIPPET_STOP_SEL) {
      mark = part === SNIPPET_START_SEL;
      continue;
    }
    if (!part) continue;
    const last = segments.at(-1);
    if (last?.mark === mark) last.text += part;
    else segments.push({ text: part, mark });
  }
  return segments;
}
