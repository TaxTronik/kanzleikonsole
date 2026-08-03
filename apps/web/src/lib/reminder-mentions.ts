// =============================================================================
// @-Erwähnungen in Wiedervorlagen-Wortmeldungen.
//
// Namen enthalten Leerzeichen („@Maria Mitarbeiterin") — ein Freitext-Parser
// müsste raten, wo der Name endet. Stattdessen wird gegen die BEKANNTE
// Personenliste abgeglichen: erwähnt ist, wessen voller Name unmittelbar nach
// einem „@" im Text steht. Case-insensitiv; E-Mail-Adressen im Text
// („info@kanzlei.de") treffen nie, weil dort kein Personenname folgt.
//
// Bewusst zod- und serverfrei: die UI (Autovervollständigung, Hervorhebung)
// und der Server (Benachrichtigung) nutzen DIESELBE Regel.
// =============================================================================

export interface MentionCandidate {
  id: string;
  fullName: string;
}

/** IDs aller Personen, deren voller Name im Text per „@" erwähnt wird. */
export function extractMentions(body: string, staff: readonly MentionCandidate[]): string[] {
  const text = body.toLowerCase();
  const treffer: string[] = [];
  for (const s of staff) {
    const name = s.fullName.trim().toLowerCase();
    if (!name) continue;
    if (text.includes('@' + name)) treffer.push(s.id);
  }
  return [...new Set(treffer)];
}

/**
 * Zerlegt einen Text in Segmente für die Anzeige — Erwähnungen getrennt vom
 * Rest, damit die UI sie hervorheben kann, ohne HTML in den Text zu mischen.
 */
export function splitByMentions(
  body: string,
  staff: readonly MentionCandidate[],
): Array<{ text: string; mention: boolean }> {
  // Längste Namen zuerst: enthält ein Name einen anderen als Präfix
  // („@Max Muster" vs. „@Max Mustermann"), gewinnt der längere Treffer.
  const namen = staff
    .map((s) => s.fullName.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (namen.length === 0 || !body.includes('@')) return [{ text: body, mention: false }];

  const segmente: Array<{ text: string; mention: boolean }> = [];
  let rest = body;
  while (rest.length > 0) {
    const lower = rest.toLowerCase();
    let bester: { index: number; laenge: number } | null = null;
    for (const name of namen) {
      const idx = lower.indexOf('@' + name.toLowerCase());
      if (idx !== -1 && (bester === null || idx < bester.index)) {
        bester = { index: idx, laenge: name.length + 1 };
      }
    }
    if (!bester) {
      segmente.push({ text: rest, mention: false });
      break;
    }
    if (bester.index > 0) segmente.push({ text: rest.slice(0, bester.index), mention: false });
    segmente.push({ text: rest.slice(bester.index, bester.index + bester.laenge), mention: true });
    rest = rest.slice(bester.index + bester.laenge);
  }
  return segmente;
}
