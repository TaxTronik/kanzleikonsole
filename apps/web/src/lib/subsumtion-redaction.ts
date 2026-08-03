// =============================================================================
// Vertrauliche Analyse: Sachverhalt auf die freigegebenen Stellen kürzen.
//
// Der Berufsträger kann eine Analyse als vertraulich kennzeichnen. Wer daran
// nur eine einzelne Markierung zur Recherche zugewiesen bekam, soll dann
// „nur den markierten Text" sehen — nicht den ganzen Sachverhalt.
//
// Der Knackpunkt ist nicht das Ausblenden, sondern die Offsets: Markierungen
// sind Zeichenpositionen IN `sourceText`. Wird der Text gekürzt, zeigen die
// alten Positionen ins Leere (oder, schlimmer, auf die falsche Stelle). Diese
// Funktion baut daher Text UND Positionen gemeinsam neu auf.
//
// Bewusst DB- und React-frei, damit die Regel ohne Umgebung testbar bleibt —
// sie ist eine Vertraulichkeitsgrenze, kein Anzeige-Detail.
// =============================================================================

/** Trennzeichen zwischen zwei freigegebenen Stellen. */
export const AUSLASSUNG = '\n[…]\n';

export interface RedactableMarking {
  id: string;
  start: number;
  end: number;
}

export interface RedactionResult<T extends RedactableMarking> {
  /** Der gekürzte Sachverhalt. */
  text: string;
  /** Nur die freigegebenen Markierungen, mit Positionen im gekürzten Text. */
  markings: T[];
  /** True, wenn tatsächlich gekürzt wurde (für den Hinweis in der UI). */
  gekuerzt: boolean;
}

/**
 * Kürzt `sourceText` auf die Stellen der freigegebenen Markierungen.
 *
 * Überlappende oder direkt aneinandergrenzende Markierungen werden zu einer
 * Stelle zusammengezogen — sonst stünde zwischen ihnen eine Auslassungsmarke,
 * obwohl gar nichts ausgelassen wurde.
 */
export function redactSachverhalt<T extends RedactableMarking>(
  sourceText: string,
  markings: readonly T[],
  freigegebeneIds: readonly string[],
): RedactionResult<T> {
  const frei = new Set(freigegebeneIds);
  const sichtbar = markings
    .filter((m) => frei.has(m.id))
    .map((m) => ({
      m,
      start: Math.max(0, Math.min(m.start, sourceText.length)),
      end: Math.max(0, Math.min(m.end, sourceText.length)),
    }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (sichtbar.length === 0) return { text: '', markings: [], gekuerzt: true };

  // Fenster zusammenziehen. `>=` statt `>`: zwei bündig aneinandergrenzende
  // Markierungen ergeben einen durchgehenden Textabschnitt.
  const fenster: Array<{ start: number; end: number }> = [];
  for (const { start, end } of sichtbar) {
    const letztes = fenster[fenster.length - 1];
    if (letztes && start <= letztes.end) letztes.end = Math.max(letztes.end, end);
    else fenster.push({ start, end });
  }

  // Text aufbauen und dabei je Fenster merken, wo es im neuen Text landet.
  let text = '';
  const basis = new Map<number, number>(); // Fenster-Startoffset → neuer Offset
  fenster.forEach((f, i) => {
    if (i > 0) text += AUSLASSUNG;
    basis.set(f.start, text.length);
    text += sourceText.slice(f.start, f.end);
  });

  const neu = sichtbar.map(({ m, start, end }) => {
    const f = fenster.find((w) => start >= w.start && end <= w.end)!;
    const verschiebung = basis.get(f.start)! - f.start;
    return { ...m, start: start + verschiebung, end: end + verschiebung };
  });

  const gekuerzt = text.length !== sourceText.length;
  return { text, markings: neu, gekuerzt };
}

export interface VertraulichkeitsEntscheidung {
  /** Die Analyse ist als vertraulich gekennzeichnet. */
  vertraulich: boolean;
  /** Volle Bearbeitungsrechte am Mandanten. */
  canWrite: boolean;
}

/**
 * Greift die Vertraulichkeit? Nur dann, wenn die Analyse so gekennzeichnet ist
 * UND die betrachtende Person keine Schreibrechte hat. Ein Berufsträger sieht
 * seinen eigenen Sachverhalt immer vollständig.
 */
export function greiftVertraulichkeit(e: VertraulichkeitsEntscheidung): boolean {
  return e.vertraulich && !e.canWrite;
}
