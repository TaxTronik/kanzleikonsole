import { describe, it, expect } from 'vitest';
import { assignTracks, buildSegments, segmentStyle, hexToRgba } from '../marking-style';
import type { MarkingDTO } from '../_ui';

// Minimal-Markierung (nur die für das Styling relevanten Felder gefüllt).
function mk(
  id: string,
  start: number,
  end: number,
  herkunft: MarkingDTO['herkunft'],
  streitig = false,
): MarkingDTO {
  return {
    id,
    start,
    end,
    matchedText: '',
    herkunft,
    engineStatus: null,
    streitig,
    begriffId: null,
    catalogReviewable: false,
    begriff: '',
    normAnker: [],
    normRefs: null,
    normketten: null,
    governanceTyp: null,
    schadensintensitaet: null,
    wahrscheinlichkeit: null,
    kaskadenreichweite: null,
    kontrolle: null,
    status: 'OFFEN',
    notiz: null,
    verantwortlichId: null,
    delegation: null,
    farbe: null,
    label: null,
  };
}

describe('assignTracks (Container oben)', () => {
  it('umschließende Markierung → Spur 0, verschachtelte → Spur 1', () => {
    const t = assignTracks([mk('inner', 10, 20, 'TRIGGER'), mk('outer', 0, 100, 'EMBEDDING')]);
    expect(t.get('outer')).toBe(0);
    expect(t.get('inner')).toBe(1);
  });
  it('nicht überlappende Markierungen teilen sich Spur 0', () => {
    const t = assignTracks([mk('a', 0, 10, 'TRIGGER'), mk('b', 20, 30, 'TRIGGER')]);
    expect(t.get('a')).toBe(0);
    expect(t.get('b')).toBe(0);
  });
  it('Kreuzungs-Überlappung → zweite eine Spur tiefer', () => {
    const t = assignTracks([mk('a', 0, 20, 'TRIGGER'), mk('b', 10, 30, 'EMBEDDING')]);
    expect(t.get('a')).toBe(0);
    expect(t.get('b')).toBe(1);
  });
});

describe('buildSegments', () => {
  it('verschachtelt → 3 Segmente; Überlappung trägt beide Markierungen', () => {
    const segs = buildSegments([mk('outer', 0, 100, 'EMBEDDING'), mk('inner', 10, 20, 'TRIGGER')]);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [10, 20],
      [20, 100],
    ]);
    expect(segs[0]!.covering.map((c) => c.m.id)).toEqual(['outer']);
    // Überlappungs-Segment: Spur 0 = outer (umschließend), Spur 1 = inner.
    expect(segs[1]!.covering.map((c) => [c.m.id, c.track])).toEqual([
      ['outer', 0],
      ['inner', 1],
    ]);
    expect(segs[2]!.covering.map((c) => c.m.id)).toEqual(['outer']);
  });
});

describe('segmentStyle', () => {
  const outer = mk('outer', 0, 100, 'EMBEDDING'); // #f59e0b
  const inner = mk('inner', 10, 20, 'TRIGGER'); // #0ea5e9

  it('einzelne Markierung: eine Linie + Füllung, unter der Grundlinie, geklont', () => {
    const s = segmentStyle([{ m: outer, track: 0 }], null, null);
    // Geometrie zoom-fähig (CSS-Var --tt-zoom; bei var=1 == 9px).
    expect(s).toContain('padding-bottom:calc(9px * var(--tt-zoom, 1))');
    expect(s).toContain('box-decoration-break:clone');
    // Spur-0-Linie 2px unter der Grundlinie → calc(100% - 7px). KEINE Durchstreichung.
    expect(s).toContain('0 calc(100% - calc(7px * var(--tt-zoom, 1)))');
    // genau ZWEI Layer (1 Linie + 1 Füllung).
    expect(s.match(/linear-gradient/g)!.length).toBe(2);
    // dezente Füllung in Markierungsfarbe, nur über dem Text.
    expect(s).toContain(hexToRgba('#f59e0b', 0.08));
    expect(s).toContain('100% calc(100% - calc(9px * var(--tt-zoom, 1)))');
  });

  it('Überlappung: zwei gestapelte Linien, Container näher am Text', () => {
    const s = segmentStyle(
      [
        { m: outer, track: 0 },
        { m: inner, track: 1 },
      ],
      null,
      null,
    );
    expect(s).toContain('0 calc(100% - calc(7px * var(--tt-zoom, 1)))'); // Spur 0 (outer) bei +2px
    expect(s).toContain('0 calc(100% - calc(4.5px * var(--tt-zoom, 1)))'); // Spur 1 (inner) bei +4.5px → tiefer
    // drei Layer: zwei Linien + eine Füllung.
    expect(s.match(/linear-gradient/g)!.length).toBe(3);
  });

  it('Hover hebt die Spanne in der eigenen Farbe hervor (kräftiger)', () => {
    const s = segmentStyle([{ m: outer, track: 0 }], null, 'outer');
    expect(s).toContain(hexToRgba('#f59e0b', 0.3));
  });

  it('Auswahl färbt die Füllung Indigo', () => {
    const s = segmentStyle([{ m: outer, track: 0 }], 'outer', null);
    expect(s).toContain('rgba(99, 102, 241, 0.2)');
  });

  it('streitig → gestrichelt + rot', () => {
    const s = segmentStyle([{ m: mk('x', 0, 5, 'TRIGGER', true), track: 0 }], null, null);
    expect(s).toContain('repeating-linear-gradient(to right, #ef4444');
  });
});
