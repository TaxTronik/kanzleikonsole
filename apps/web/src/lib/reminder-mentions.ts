// =============================================================================
// @-Erwähnungen in Wiedervorlagen-Wortmeldungen.
//
// Namen enthalten Leerzeichen („@Maria Mitarbeiterin") — ein Freitext-Parser
// müsste raten, wo der Name endet. Stattdessen wird gegen die BEKANNTE
// Personenliste abgeglichen. Erwähnt ist:
//   1. wessen VOLLER Name unmittelbar nach einem „@" steht (längster gewinnt),
//   2. sonst: wessen VORNAME dort steht — aber nur, wenn er im Team eindeutig
//      ist („@Maria" reicht, solange es genau eine Maria gibt; bei zwei Marias
//      passiert bewusst nichts, das löst die Autovervollständigung auf).
// Case-insensitiv; E-Mail-Adressen („info@kanzlei.de") treffen nie, weil vor
// ihrem „@" ein Wortzeichen steht.
//
// Bewusst zod- und serverfrei: die UI (Autovervollständigung, Hervorhebung)
// und der Server (Benachrichtigung) nutzen DENSELBEN Matcher — was leuchtet,
// wird benachrichtigt, und umgekehrt.
// =============================================================================

export interface MentionCandidate {
  id: string;
  fullName: string;
}

interface Treffer {
  /** Position des „@" im Text. */
  index: number;
  /** Länge des Treffers inklusive „@". */
  laenge: number;
  /** Erwähnte Personen (mehrere nur bei exakt gleichlautenden vollen Namen). */
  ids: string[];
}

const WORTZEICHEN = /[\p{L}\p{N}_-]/u;

function istWortzeichen(zeichen: string | undefined): boolean {
  return zeichen !== undefined && WORTZEICHEN.test(zeichen);
}

/** Alle @-Treffer im Text, positionsgenau — gemeinsame Basis beider Exporte. */
function findeMentions(body: string, staff: readonly MentionCandidate[]): Treffer[] {
  const lower = body.toLowerCase();

  const personen = staff
    .map((s) => ({ id: s.id, name: s.fullName.trim().toLowerCase() }))
    .filter((p) => p.name.length > 0);
  if (personen.length === 0 || !body.includes('@')) return [];

  // Längste Namen zuerst: enthält ein Name einen anderen als Präfix
  // („@Max Muster" vs. „@Max Mustermann"), gewinnt der längere Treffer.
  const nachLaenge = [...personen].sort((a, b) => b.name.length - a.name.length);

  const vornamen = new Map<string, string[]>();
  for (const p of personen) {
    const vorname = p.name.split(/\s+/)[0]!;
    vornamen.set(vorname, [...(vornamen.get(vorname) ?? []), p.id]);
  }

  const treffer: Treffer[] = [];
  let i = lower.indexOf('@');
  while (i !== -1) {
    // „info@kanzlei.de": vor dem „@" steht ein Wortzeichen — keine Erwähnung.
    if (istWortzeichen(body[i - 1])) {
      i = lower.indexOf('@', i + 1);
      continue;
    }

    let gefunden: Treffer | null = null;
    for (const p of nachLaenge) {
      if (!lower.startsWith(p.name, i + 1)) continue;
      // „@Maria Mitarbeiterinnen" ist kein Treffer für „Maria Mitarbeiterin".
      if (istWortzeichen(body[i + 1 + p.name.length])) continue;
      const ids = personen.filter((q) => q.name === p.name).map((q) => q.id);
      gefunden = { index: i, laenge: p.name.length + 1, ids };
      break;
    }

    if (!gefunden) {
      const wort = /^[\p{L}][\p{L}.-]*/u.exec(body.slice(i + 1));
      const ids = wort ? vornamen.get(wort[0].toLowerCase()) : undefined;
      if (wort && ids && ids.length === 1) {
        gefunden = { index: i, laenge: wort[0].length + 1, ids };
      }
    }

    if (gefunden) {
      treffer.push(gefunden);
      i = lower.indexOf('@', gefunden.index + gefunden.laenge);
    } else {
      i = lower.indexOf('@', i + 1);
    }
  }
  return treffer;
}

/** IDs aller Personen, die im Text per „@" erwähnt werden. */
export function extractMentions(body: string, staff: readonly MentionCandidate[]): string[] {
  return [...new Set(findeMentions(body, staff).flatMap((t) => t.ids))];
}

/**
 * Zerlegt einen Text in Segmente für die Anzeige — Erwähnungen getrennt vom
 * Rest, damit die UI sie hervorheben kann, ohne HTML in den Text zu mischen.
 */
export function splitByMentions(
  body: string,
  staff: readonly MentionCandidate[],
): Array<{ text: string; mention: boolean }> {
  const treffer = findeMentions(body, staff);
  if (treffer.length === 0) return [{ text: body, mention: false }];

  const segmente: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  for (const t of treffer) {
    if (t.index > cursor) segmente.push({ text: body.slice(cursor, t.index), mention: false });
    segmente.push({ text: body.slice(t.index, t.index + t.laenge), mention: true });
    cursor = t.index + t.laenge;
  }
  if (cursor < body.length) segmente.push({ text: body.slice(cursor), mention: false });
  return segmente;
}
