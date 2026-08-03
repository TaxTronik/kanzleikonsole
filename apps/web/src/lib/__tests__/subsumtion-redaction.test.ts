import { describe, it, expect } from 'vitest';
import {
  AUSLASSUNG,
  greiftVertraulichkeit,
  redactSachverhalt,
  type RedactableMarking,
} from '../subsumtion-redaction';

// «0123456789…» — die Positionen sind absichtlich leicht nachzurechnen.
const TEXT = 'Der Mandant führte Bargeschäfte und daneben eine Kassenführung ohne Beleg.';
const BAR = { id: 'bar', start: TEXT.indexOf('Bargeschäfte') };
const KASSE = { id: 'kasse', start: TEXT.indexOf('Kassenführung') };

const MARKS: RedactableMarking[] = [
  { id: 'bar', start: BAR.start, end: BAR.start + 'Bargeschäfte'.length },
  { id: 'kasse', start: KASSE.start, end: KASSE.start + 'Kassenführung'.length },
];

/** Was die Markierung im Ergebnis-Text tatsächlich überdeckt. */
function ausschnitt(r: { text: string; markings: RedactableMarking[] }, id: string): string {
  const m = r.markings.find((x) => x.id === id)!;
  return r.text.slice(m.start, m.end);
}

describe('redactSachverhalt', () => {
  it('gibt nur die freigegebene Stelle heraus', () => {
    const r = redactSachverhalt(TEXT, MARKS, ['bar']);
    expect(r.text).toBe('Bargeschäfte');
    expect(r.markings).toHaveLength(1);
    expect(r.gekuerzt).toBe(true);
    // Der übrige Sachverhalt darf nirgends durchschlagen.
    expect(r.text).not.toContain('Kassenführung');
    expect(r.text).not.toContain('Mandant');
  });

  it('basiert die Offsets auf den gekürzten Text um', () => {
    const r = redactSachverhalt(TEXT, MARKS, ['bar', 'kasse']);
    // Genau das ist die Falle: die alten Offsets (19 / 48) zeigen im kurzen
    // Text auf nichts. Nach dem Umbasieren decken sie wieder ihr Wort.
    expect(ausschnitt(r, 'bar')).toBe('Bargeschäfte');
    expect(ausschnitt(r, 'kasse')).toBe('Kassenführung');
    expect(r.text).toBe(`Bargeschäfte${AUSLASSUNG}Kassenführung`);
  });

  it('zieht überlappende und bündig angrenzende Stellen zu einer zusammen', () => {
    const t = 'ABCDEF';
    const ueberlappend = redactSachverhalt(
      t,
      [
        { id: 'a', start: 0, end: 3 },
        { id: 'b', start: 2, end: 5 },
      ],
      ['a', 'b'],
    );
    expect(ueberlappend.text).toBe('ABCDE');
    expect(ausschnitt(ueberlappend, 'a')).toBe('ABC');
    expect(ausschnitt(ueberlappend, 'b')).toBe('CDE');

    const buendig = redactSachverhalt(
      t,
      [
        { id: 'a', start: 0, end: 3 },
        { id: 'b', start: 3, end: 6 },
      ],
      ['a', 'b'],
    );
    // Kein „[…]" zwischen zwei Stellen, zwischen denen nichts ausgelassen wurde.
    expect(buendig.text).toBe('ABCDEF');
    expect(buendig.gekuerzt).toBe(false);
  });

  it('gibt bei leerer Freigabe gar nichts heraus', () => {
    const r = redactSachverhalt(TEXT, MARKS, []);
    expect(r.text).toBe('');
    expect(r.markings).toEqual([]);
    expect(r.gekuerzt).toBe(true);
  });

  it('ignoriert eine unbekannte Freigabe-ID, statt fremden Text zu zeigen', () => {
    const r = redactSachverhalt(TEXT, MARKS, ['gibt-es-nicht']);
    expect(r.text).toBe('');
    expect(r.markings).toEqual([]);
  });

  it('klemmt Offsets ausserhalb des Textes ab', () => {
    const r = redactSachverhalt('kurz', [{ id: 'x', start: 2, end: 999 }], ['x']);
    expect(r.text).toBe('rz');
    expect(ausschnitt(r, 'x')).toBe('rz');
  });

  it('verwirft eine leere Markierung (start === end)', () => {
    const r = redactSachverhalt(TEXT, [{ id: 'leer', start: 5, end: 5 }], ['leer']);
    expect(r.text).toBe('');
    expect(r.markings).toEqual([]);
  });

  it('behält Zusatzfelder der Markierung', () => {
    const r = redactSachverhalt(
      TEXT,
      [{ id: 'bar', start: BAR.start, end: BAR.start + 12, begriff: 'Bargeschäfte' }],
      ['bar'],
    );
    expect(r.markings[0]!.begriff).toBe('Bargeschäfte');
  });

  it('sortiert unsortierte Eingaben nach Position', () => {
    const r = redactSachverhalt(TEXT, [MARKS[1]!, MARKS[0]!], ['bar', 'kasse']);
    expect(r.text).toBe(`Bargeschäfte${AUSLASSUNG}Kassenführung`);
  });
});

describe('greiftVertraulichkeit', () => {
  it('greift nur bei vertraulicher Analyse ohne Schreibrecht', () => {
    expect(greiftVertraulichkeit({ vertraulich: true, canWrite: false })).toBe(true);
    expect(greiftVertraulichkeit({ vertraulich: true, canWrite: true })).toBe(false);
    expect(greiftVertraulichkeit({ vertraulich: false, canWrite: false })).toBe(false);
    expect(greiftVertraulichkeit({ vertraulich: false, canWrite: true })).toBe(false);
  });
});
