import { describe, it, expect } from 'vitest';
import { extractNormRefs, scoreMarkingSuggestions, type ScoreableMarking } from '../suggest';

describe('extractNormRefs', () => {
  it('zieht §-Zitate heraus, ignoriert losen Text', () => {
    expect(extractNormRefs('Prüfe § 8 KStG und § 42 AO sowie irgendwas.')).toEqual(['§ 8 KStG', '§ 42 AO']);
  });
});

describe('scoreMarkingSuggestions', () => {
  const marks: ScoreableMarking[] = [
    { id: 'a', begriff: 'Gestaltungsmissbrauch', normAnker: ['§ 42 AO'], status: 'OFFEN' },
    { id: 'b', begriff: 'Verrechnungspreis', normAnker: ['§ 1 AStG'], status: 'IN_PRUEFUNG' },
    { id: 'c', begriff: 'Erledigt', normAnker: ['§ 42 AO'], status: 'KONTROLLIERT' }, // gefiltert
  ];

  it('Normanker-Überlappung (×3) + Begriff-Treffer (×2); Status-Filter greift', () => {
    const res = scoreMarkingSuggestions(
      { title: null, body: 'Hier liegt ein Gestaltungsmissbrauch nach § 42 AO vor.' },
      marks,
    );
    expect(res[0]).toMatchObject({ markingId: 'a', score: 5, reason: '1 gemeinsame Normanker · Begriff erwähnt' });
    expect(res.find((r) => r.markingId === 'c')).toBeUndefined(); // KONTROLLIERT ausgeschlossen
  });

  it('nur Normanker-Treffer → Score 3', () => {
    const res = scoreMarkingSuggestions({ title: null, body: 'Etwas zu § 1 AStG.' }, marks);
    expect(res[0]).toMatchObject({ markingId: 'b', score: 3 });
  });

  it('kein Treffer → leer', () => {
    expect(scoreMarkingSuggestions({ title: null, body: 'Völlig anderes Thema.' }, marks)).toEqual([]);
  });
});
