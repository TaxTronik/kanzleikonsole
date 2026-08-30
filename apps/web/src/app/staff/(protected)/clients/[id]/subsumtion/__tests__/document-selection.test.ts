import { describe, expect, it } from 'vitest';
import { smallestCoveringMarking } from '../subsumtion-document';

describe('RISK-AI-SUGGESTION-001: unveränderte Auswahl der kleinsten sichtbaren Markierung', () => {
  const outer = { id: 'outer', start: 0, end: 30 };
  const inner = { id: 'inner', start: 10, end: 20 };

  it('wählt die engste überdeckende Markierung, ohne Objekte oder Reihenfolge zu verändern', () => {
    const markings = [outer, inner];
    expect(smallestCoveringMarking(markings, 15)).toBe(inner);
    expect(markings).toEqual([outer, inner]);
  });

  it('bezieht Anfang und Ende wie bisher ein', () => {
    expect(smallestCoveringMarking([outer, inner], 10)).toBe(inner);
    expect(smallestCoveringMarking([outer, inner], 20)).toBe(inner);
    expect(smallestCoveringMarking([outer, inner], 30)).toBe(outer);
  });

  it('behält bei gleich langen Treffern den ersten Eintrag', () => {
    const equal = { id: 'equal', start: 11, end: 21 };
    expect(smallestCoveringMarking([inner, equal], 15)).toBe(inner);
    expect(smallestCoveringMarking([equal, inner], 15)).toBe(equal);
  });

  it('liefert ohne Position oder Treffer keine Auswahl', () => {
    expect(smallestCoveringMarking([outer], null)).toBeNull();
    expect(smallestCoveringMarking([outer], 31)).toBeNull();
    expect(smallestCoveringMarking([], 10)).toBeNull();
  });
});
