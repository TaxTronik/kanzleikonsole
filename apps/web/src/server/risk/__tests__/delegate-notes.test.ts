import { describe, it, expect } from 'vitest';
import {
  buildDelegationNotes,
  parseDelegationNotes,
  type DelegationMarkingContext,
} from '../delegate-notes';

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

describe('parseDelegationNotes', () => {
  it('liest zurück, was gebaut wurde — ohne die UUIDs', () => {
    const p = parseDelegationNotes(buildDelegationNotes(marking, 'Bitte bis KW 12 prüfen.'));
    expect(p.begriff).toBe('Kassenführung');
    expect(p.normAnker).toEqual(['§ 146 AO', '§ 158 AO']);
    expect(p.fundstelle).toBe('Bargeschäfte');
    expect(p.span).toEqual({ start: 10, end: 24 });
    expect(p.auftrag).toBe('Bitte bis KW 12 prüfen.');
    expect(p.rest).toEqual([]);
    // Die IDs dürfen in keinem Anzeigefeld auftauchen.
    expect(JSON.stringify(p)).not.toContain('an-1');
    expect(JSON.stringify(p)).not.toContain('mk-1');
    expect(JSON.stringify(p)).not.toContain('doc-9');
  });

  it('behandelt eine Fundstelle mit Anführungszeichen und Umbruch im Zitat', () => {
    const p = parseDelegationNotes(
      buildDelegationNotes({ ...marking, matchedText: 'Er nannte es "bar"' }),
    );
    expect(p.fundstelle).toBe('Er nannte es "bar"');
  });

  it('lässt eine handgeschriebene Notiz unverändert stehen', () => {
    const p = parseDelegationNotes('Kurz mit Herrn M. telefonieren.');
    expect(p.begriff).toBeNull();
    expect(p.fundstelle).toBeNull();
    expect(p.rest).toEqual(['Kurz mit Herrn M. telefonieren.']);
  });

  it('verträgt leere und fehlende Notizen', () => {
    for (const leer of [null, undefined, '']) {
      const p = parseDelegationNotes(leer);
      expect(p.begriff).toBeNull();
      expect(p.auftrag).toBeNull();
      expect(p.rest).toEqual([]);
    }
  });

  it('fällt bei unbekanntem Fundstellen-Format auf den Rohwert zurück', () => {
    const p = parseDelegationNotes('Begriff: X\nFundstelle: irgendwo hinten');
    expect(p.fundstelle).toBe('irgendwo hinten');
    expect(p.span).toBeNull();
  });
});
