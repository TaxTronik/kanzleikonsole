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
  // matchedText einzeilig halten: das Notiz-Format ist zeilenbasiert — ein
  // Umbruch im markierten Text wuerde die Fundstelle-Zeile zerreissen (und eine
  // Leerzeile im Zitat liesse den Rest als Freitext-Auftrag erscheinen).
  const zitat = marking.matchedText.replace(/\s*\n\s*/g, ' ');
  lines.push(`Fundstelle: Zeichen ${marking.start}–${marking.end} ("${zitat}")`);
  lines.push(`Analyse: ${marking.analysisId}`);
  lines.push(`Markierung: ${marking.id}`);
  if (marking.analysis.documentId) lines.push(`Dokument: ${marking.analysis.documentId}`);
  if (extra && extra.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

export interface ParsedDelegationNotes {
  begriff: string | null;
  normAnker: string[];
  /** Der markierte Sachverhaltsausschnitt — das, was zur Recherche freigegeben ist. */
  fundstelle: string | null;
  /** Zeichen-Offsets, rein technisch — nicht für die Anzeige gedacht. */
  span: { start: number; end: number } | null;
  /** Freitext der delegierenden Person (alles nach der Leerzeile). */
  auftrag: string | null;
  /** Zeilen, die keinem bekannten Anker entsprachen (Fremd-/Altformate). */
  rest: string[];
}

const ANKER = /^(Begriff|Normanker|Fundstelle|Analyse|Markierung|Dokument):\s*(.*)$/;
const FUNDSTELLE = /^Zeichen\s+(\d+)[–-](\d+)\s*\((?:"|„)([\s\S]*)(?:"|“)\s*\)$/;

/**
 * Zerlegt eine Delegations-Notiz in ihre Bestandteile.
 *
 * Die Notiz wurde bisher als roher Textblock ausgegeben — inklusive dreier
 * UUIDs, die für Menschen nichts aussagen, und mit dem Zitat aus dem
 * Sachverhalt mitten in einer technischen Zeile. Der Parser trennt das:
 * die IDs verschwinden aus der Anzeige (die Navigation läuft ohnehin über
 * `researchMarkingId`), das Zitat bekommt eine eigene, als Zitat erkennbare
 * Darstellung, und der Freitext des Auftrags steht getrennt davon.
 *
 * Bewusst tolerant: bestehende Wiedervorlagen in der DB tragen das alte
 * Format, und eine von Hand geschriebene Notiz ist kein Fehlerfall — was
 * nicht erkannt wird, landet unverändert in `rest`.
 */
export function parseDelegationNotes(notes: string | null | undefined): ParsedDelegationNotes {
  const out: ParsedDelegationNotes = {
    begriff: null,
    normAnker: [],
    fundstelle: null,
    span: null,
    auftrag: null,
    rest: [],
  };
  if (!notes) return out;

  const zeilen = notes.split('\n');
  let i = 0;
  for (; i < zeilen.length; i++) {
    const zeile = zeilen[i]!;
    if (zeile.trim() === '') break; // Leerzeile trennt Anker vom Freitext
    const m = ANKER.exec(zeile);
    if (!m) {
      out.rest.push(zeile);
      continue;
    }
    const [, key, wert] = m as unknown as [string, string, string];
    switch (key) {
      case 'Begriff':
        out.begriff = wert.trim() || null;
        break;
      case 'Normanker':
        out.normAnker = wert
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case 'Fundstelle': {
        const f = FUNDSTELLE.exec(wert.trim());
        if (f) {
          out.span = { start: Number(f[1]), end: Number(f[2]) };
          out.fundstelle = f[3] ?? null;
        } else {
          out.fundstelle = wert.trim() || null;
        }
        break;
      }
      // Analyse/Markierung/Dokument sind UUIDs — bewusst verworfen.
    }
  }

  const freitext = zeilen.slice(i).join('\n').trim();
  out.auftrag = freitext || null;
  return out;
}
