// =============================================================================
// EINE gemeinsame Serialisierung Rich-Doc (ProseMirror) → Plaintext + Offset-Map.
//
// Dieselbe Funktion liefert (a) den Plaintext, der analysiert/gehasht wird, und
// (b) die Zuordnung Plaintext-Offset ↔ ProseMirror-Position. Dadurch sind die
// Engine-Markierungen (Offsets im Plaintext) bauartbedingt deckungsgleich mit
// den Decorations im formatierten Review — kein Drift.
//
// Regel: Block-Knoten (Absatz/Überschrift/Listenpunkt) werden mit Leerzeile
// (\n\n) getrennt, hardBreak = \n. Idempotent über Verschachtelung (kein
// doppelter Separator).
// =============================================================================

import type { Node as PMNode } from '@tiptap/pm/model';

export interface TextRange {
  /** ProseMirror-Positionen des Textlaufs. */
  from: number;
  to: number;
  /** Plaintext-Offsets desselben Laufs. */
  plainStart: number;
  plainEnd: number;
}

export interface DocText {
  text: string;
  ranges: TextRange[];
}

function walk(
  node: PMNode,
  contentStart: number,
  ctx: { text: string; ranges: TextRange[] },
): void {
  node.forEach((child, offset) => {
    const pos = contentStart + offset; // absolute PM-Position VOR dem Kind
    if (child.isText && child.text) {
      const plainStart = ctx.text.length;
      ctx.text += child.text;
      ctx.ranges.push({
        from: pos,
        to: pos + child.text.length,
        plainStart,
        plainEnd: ctx.text.length,
      });
    } else if (child.type.name === 'hardBreak') {
      ctx.text += '\n';
    } else if (child.isBlock) {
      if (ctx.text.length > 0 && !ctx.text.endsWith('\n\n')) ctx.text += '\n\n';
      walk(child, pos + 1, ctx); // Block-Content beginnt nach dem Öffnungs-Token
    }
  });
}

export function docToText(doc: PMNode): DocText {
  const ctx = { text: '', ranges: [] as TextRange[] };
  walk(doc, 0, ctx);
  return { text: ctx.text, ranges: ctx.ranges };
}

// -----------------------------------------------------------------------------
// Server-Variante: NUR der Plaintext aus dem Tiptap-JSON — OHNE ProseMirror-
// Schema/DOM, damit sie in einer Server-Action läuft. Muss bitgenau dieselbe
// Ausgabe liefern wie docToText(node).text (gleicher Separator-Regelsatz:
// text = Inhalt, hardBreak = \n, jeder andere Knoten = Block mit \n\n davor,
// idempotent). Damit lässt sich serverseitig zuverlässig „nur Formatierung
// geändert" von „Textinhalt geändert" unterscheiden.
// -----------------------------------------------------------------------------
interface JsonNode {
  type?: string;
  text?: string;
  content?: JsonNode[];
}

export function jsonDocToText(json: unknown): string {
  let text = '';
  const visit = (node: JsonNode): void => {
    for (const child of node.content ?? []) {
      if (child.type === 'text' && typeof child.text === 'string') {
        text += child.text;
      } else if (child.type === 'hardBreak') {
        text += '\n';
      } else if (child.type && child.type !== 'text') {
        // jeder andere Knoten ist ein Block (StarterKit hat außer hardBreak keine
        // Inline-Atome) → wie docToText: Leerzeile davor (idempotent), dann rein.
        if (text.length > 0 && !text.endsWith('\n\n')) text += '\n\n';
        visit(child);
      }
    }
  };
  if (json && typeof json === 'object') visit(json as JsonNode);
  return text;
}

/** Markierungs-[start,end] (Plaintext-Offsets) → ProseMirror-Bereiche. */
export function plainRangeToPm(
  ranges: TextRange[],
  start: number,
  end: number,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const r of ranges) {
    const s = Math.max(start, r.plainStart);
    const e = Math.min(end, r.plainEnd);
    if (e > s) out.push({ from: r.from + (s - r.plainStart), to: r.from + (e - r.plainStart) });
  }
  return out;
}

/** ProseMirror-Position → Plaintext-Offset (für manuelle Markierung). */
export function pmPosToPlain(ranges: TextRange[], pos: number): number | null {
  for (const r of ranges) {
    if (pos >= r.from && pos <= r.to) return r.plainStart + (pos - r.from);
  }
  // Position in einem Separator/Leerbereich → nächstgelegene Laufgrenze.
  let best: number | null = null;
  let bestDist = Infinity;
  for (const r of ranges) {
    for (const [p, plain] of [
      [r.from, r.plainStart],
      [r.to, r.plainEnd],
    ] as const) {
      const d = Math.abs(p - pos);
      if (d < bestDist) {
        bestDist = d;
        best = plain;
      }
    }
  }
  return best;
}
