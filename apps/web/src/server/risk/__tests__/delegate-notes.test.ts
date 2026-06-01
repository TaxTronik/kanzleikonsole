import { describe, it, expect } from 'vitest';
import { buildDelegationNotes, type DelegationMarkingContext } from '../delegate-notes';

const marking: DelegationMarkingContext = {
  begriff: 'Kassenführung',
  normAnker: ['§ 146 AO', '§ 158 AO'],
  start: 10,
  end: 24,
  matchedText: 'Bargeschäfte',
  analysisId: 'an-1',
  id: 'mk-1',
  analysis: { documentId: 'doc-9' },
};

describe('buildDelegationNotes', () => {
  it('nimmt alle Kontext-Anker auf', () => {
    const notes = buildDelegationNotes(marking);
    expect(notes).toContain('Begriff: Kassenführung');
    expect(notes).toContain('Normanker: § 146 AO, § 158 AO');
    expect(notes).toContain('Fundstelle: Zeichen 10–24 ("Bargeschäfte")');
    expect(notes).toContain('Analyse: an-1');
    expect(notes).toContain('Markierung: mk-1');
    expect(notes).toContain('Dokument: doc-9');
  });

  it('lässt Normanker- und Dokument-Zeile weg, wenn leer/nicht vorhanden', () => {
    const notes = buildDelegationNotes({
      ...marking,
      normAnker: [],
      analysis: { documentId: null },
    });
    expect(notes).not.toContain('Normanker:');
    expect(notes).not.toContain('Dokument:');
    expect(notes).toContain('Begriff: Kassenführung');
  });

  it('hängt Freitext-Zusatz unten an', () => {
    const notes = buildDelegationNotes(marking, '  Bitte bis KW 12 prüfen.  ');
    expect(notes.endsWith('Bitte bis KW 12 prüfen.')).toBe(true);
  });
});
