// =============================================================================
// Reflow für importierte Sachverhalte (DB-frei, testbar).
//
// Importierter Text (DOCX/PDF/Paste) ist oft hart umbrochen — jede ~75-Zeichen-
// Zeile als eigener Absatz (\n\n zwischen jeder Zeile). Das ergibt in der n8n-
// Vorschau hässliche Leerzeilen mitten im Satz. reflowProse führt harte
// Zeilenumbrüche wieder zu Fließtext zusammen und lässt einen Absatzumbruch nur
// dort, wo der vorige Absatz mit Satzende/Doppelpunkt schließt oder eine Liste
// beginnt. Auf bereits sauberem Text ist es ein No-Op (nichts wird zusammengeführt).
// =============================================================================

const isListItem = (s: string) => /^([-*•·–]|\(?\d+[.)]|[a-zA-Z][.)])\s/.test(s);

export function reflowProse(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((p) =>
      p
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  const out: string[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    // An den vorigen Absatz anhängen, wenn dieser NICHT mit Satzende/Doppelpunkt
    // schließt und weder hier noch dort ein Listenpunkt vorliegt (= der Umbruch
    // war wahrscheinlich ein harter Zeilenumbruch, kein echter Absatz).
    if (prev && !/[.!?:…»”"')\]]\s*$/.test(prev) && !isListItem(block) && !isListItem(prev)) {
      out[out.length - 1] = prev + ' ' + block;
    } else {
      out.push(block);
    }
  }
  return out.join('\n\n');
}
