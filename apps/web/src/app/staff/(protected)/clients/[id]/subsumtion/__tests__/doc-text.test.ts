import { describe, it, expect } from 'vitest';
import { plainRangeToPm, pmPosToPlain, type TextRange } from '../doc-text';

// Zwei Textläufe in zwei Absätzen:
//   Absatz 1 "Hallo" → PM [1,6],  Plaintext [0,5]
//   (Separator "\n\n" → Plaintext [5,7], KEINE PM-Position)
//   Absatz 2 "Welt"  → PM [8,12], Plaintext [7,11]
const ranges: TextRange[] = [
  { from: 1, to: 6, plainStart: 0, plainEnd: 5 },
  { from: 8, to: 12, plainStart: 7, plainEnd: 11 },
];

describe('plainRangeToPm', () => {
  it('mappt einen Offset-Bereich innerhalb eines Laufs auf PM', () => {
    expect(plainRangeToPm(ranges, 1, 4)).toEqual([{ from: 2, to: 5 }]);
  });

  it('teilt einen Bereich über den Absatz-Separator hinweg auf (Separator entfällt)', () => {
    // Plaintext [3,9] überdeckt Lauf1 plain[3,5]→PM[4,6] und Lauf2 plain[7,9]→PM[8,10].
    expect(plainRangeToPm(ranges, 3, 9)).toEqual([
      { from: 4, to: 6 },
      { from: 8, to: 10 },
    ]);
  });

  it('liefert nichts für einen Bereich ganz im Separator', () => {
    expect(plainRangeToPm(ranges, 5, 7)).toEqual([]);
  });
});

describe('pmPosToPlain', () => {
  it('mappt eine PM-Position innerhalb eines Laufs auf den Plaintext-Offset', () => {
    expect(pmPosToPlain(ranges, 3)).toBe(2); // Lauf1: from1→plain0, pos3→plain2
    expect(pmPosToPlain(ranges, 8)).toBe(7); // Lauf2-Anfang → plain7
    expect(pmPosToPlain(ranges, 12)).toBe(11); // Lauf2-Ende → plain11
  });

  it('fällt für Positionen außerhalb der Läufe auf einen Plaintext-Offset zurück (nicht null)', () => {
    expect(typeof pmPosToPlain(ranges, 7)).toBe('number');
  });
});
