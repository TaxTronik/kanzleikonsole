// =============================================================================
// Reine Style-Logik für die Markierungs-Darstellung im Review (DB-/Tiptap-frei,
// daher unit-testbar). Kernidee:
//
//  • assignTracks: globale Spur je Markierung (Container/größer oben = Spur 0).
//  • Rendering pro DISJUNKTEM Segment (an jeder Markierungsgrenze geschnitten) →
//    keine überlappenden Decorations → ProseMirror verschmilzt keine Styles.
//  • segmentStyle: EINE Decoration pro Segment mit MEHREREN Hintergrund-Layern —
//    je überdeckende Markierung eine Linie auf ihrer Spur (zuverlässig gestapelt)
//    + EINER Füllung (kein Stapeln → kein Matsch). Position über padding-bottom +
//    calc(100% - …) → immer unter der Grundlinie, schriftgrößen-unabhängig.
// =============================================================================

import { type MarkingDTO, herkunftColor } from './_ui';

// Geometrie der gestapelten Linien (px).
export const LINE_PAD = 9; // verlängert die Span-Unterkante nach unten (Platz für Linien)
const LINE_BASE = 2; // erste Spur px unter der Grundlinie
const LINE_GAP = 2.5; // Abstand je weiterer Spur
const MAX_TRACK = 2; // ab hier teilen sich tiefere Spuren die unterste Linie

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const markColor = (m: MarkingDTO) => (m.streitig ? '#ef4444' : herkunftColor(m.herkunft));

/**
 * Globale Spur je Markierung für DURCHGEHENDE Linien. Sortierung start↑, end↓ +
 * Greedy auf die flachste freie Spur → umschließende/größere Markierungen liegen
 * oben (Spur 0, direkt unter dem Text), verschachtelte darunter. Eine Spur bleibt
 * über die ganze Spanne gleich → die Linie ist durchgehend.
 */
export function assignTracks(marks: MarkingDTO[]): Map<string, number> {
  const sorted = [...marks].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const trackEnds: number[] = [];
  const tracks = new Map<string, number>();
  for (const m of sorted) {
    let t = 0;
    while (t < trackEnds.length && trackEnds[t]! > m.start) t++;
    trackEnds[t] = m.end;
    tracks.set(m.id, t);
  }
  return tracks;
}

/** Ein Linien-Layer für eine Markierung an ihrer Spur. */
function lineLayer(m: MarkingDTO, track: number): { image: string; size: string; pos: string } {
  const color = markColor(m);
  const off = LINE_BASE + Math.min(track, MAX_TRACK) * LINE_GAP; // px unter der Grundlinie
  const image = m.streitig
    ? `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 7px)` // gestrichelt
    : `linear-gradient(${color}, ${color})`; // durchgezogen
  return { image, size: '100% 2px', pos: `0 calc(100% - ${LINE_PAD - off}px)` };
}

export interface CoveringMark {
  m: MarkingDTO;
  track: number;
}

/**
 * Style EINES Segments. `covering` = die das Segment überdeckenden Markierungen,
 * aufsteigend nach Spur (Spur 0 = oberste). Liefert die CSS-Deklaration (mehrere
 * Linien-Layer + eine Füllung). Hover = Spanne in eigener Farbe, Auswahl = Indigo,
 * sonst dezente Tönung der obersten Markierung.
 */
export function segmentStyle(
  covering: CoveringMark[],
  selectedId: string | null,
  hoveredId: string | null,
): string {
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  for (const { m, track } of covering) {
    const l = lineLayer(m, track);
    images.push(l.image); sizes.push(l.size); positions.push(l.pos);
  }
  const hov = covering.find((c) => c.m.id === hoveredId)?.m;
  const sel = covering.find((c) => c.m.id === selectedId)?.m;
  const top = covering[0]?.m; // Spur 0 = oberste/umschließende
  const fill = hov
    ? hexToRgba(markColor(hov), 0.3)
    : sel
      ? 'rgba(99, 102, 241, 0.2)'
      : top
        ? hexToRgba(markColor(top), 0.08)
        : null;
  if (fill) {
    images.push(`linear-gradient(${fill}, ${fill})`);
    sizes.push(`100% calc(100% - ${LINE_PAD}px)`); // nur über dem Text, nicht in der Linien-Zone
    positions.push('0 0');
  }
  return (
    `padding-bottom:${LINE_PAD}px; cursor:pointer;` +
    // clone: jede umbrochene Zeile bekommt Linien + Füllung voll (Default „slice"
    // zeichnet Padding/Hintergrund nur an den echten Element-Enden).
    `-webkit-box-decoration-break:clone; box-decoration-break:clone;` +
    `background-image:${images.join(', ')};` +
    `background-repeat:${images.map(() => 'no-repeat').join(', ')};` +
    `background-size:${sizes.join(', ')};` +
    `background-position:${positions.join(', ')};`
  );
}

/**
 * Schneidet Markierungen in disjunkte Segmente (an jeder Grenze) und liefert je
 * Segment die überdeckenden Markierungen (nach Spur sortiert). Plaintext-Offsets
 * — die PM-Zuordnung macht der Aufrufer.
 */
export function buildSegments(
  marks: MarkingDTO[],
): Array<{ start: number; end: number; covering: CoveringMark[] }> {
  const tracks = assignTracks(marks);
  const bounds = new Set<number>();
  for (const m of marks) { bounds.add(m.start); bounds.add(m.end); }
  const points = [...bounds].sort((x, y) => x - y);
  const segs: Array<{ start: number; end: number; covering: CoveringMark[] }> = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    if (b <= a) continue;
    const covering = marks
      .filter((m) => m.start <= a && m.end >= b)
      .map((m) => ({ m, track: tracks.get(m.id) ?? 0 }))
      .sort((x, y) => x.track - y.track);
    if (covering.length > 0) segs.push({ start: a, end: b, covering });
  }
  return segs;
}
