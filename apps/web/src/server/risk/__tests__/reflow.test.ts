import { describe, it, expect } from 'vitest';
import { reflowProse } from '../reflow';

describe('reflowProse', () => {
  it('führt hart umbrochene Zeilen (jede ~Zeile ein Absatz) zu Fließtext zusammen', () => {
    // Synthetisch: ein Satz über drei „Absätze" hart umbrochen.
    const frag = 'Beide Gesellschaften werden von derselben Person geführt; in der Firma\n\nkann diese Person jede Entscheidung\n\nvon vornherein unterbinden.';
    expect(reflowProse(frag)).toBe(
      'Beide Gesellschaften werden von derselben Person geführt; in der Firma kann diese Person jede Entscheidung von vornherein unterbinden.',
    );
  });

  it('lässt einen Absatzumbruch bei Satzende stehen', () => {
    const t = 'Erster Satz endet hier.\n\nZweiter Gedanke ohne Satzende am Zeilenende\n\ngeht weiter bis zum Punkt.';
    expect(reflowProse(t)).toBe('Erster Satz endet hier.\n\nZweiter Gedanke ohne Satzende am Zeilenende geht weiter bis zum Punkt.');
  });

  it('ist ein No-Op für bereits sauberen Mehrabsatz-Text', () => {
    const clean = 'Absatz eins endet sauber.\n\nAbsatz zwei steht für sich.';
    expect(reflowProse(clean)).toBe(clean);
  });

  it('bewahrt Listenpunkte als eigene Zeilen', () => {
    const list = 'Zu prüfen ist:\n\n- erster Punkt\n\n- zweiter Punkt';
    expect(reflowProse(list)).toBe('Zu prüfen ist:\n\n- erster Punkt\n\n- zweiter Punkt');
  });

  it('glättet harte Einzelumbrüche innerhalb eines Absatzes zu Leerzeichen', () => {
    expect(reflowProse('Zeile eins\nZeile zwei.')).toBe('Zeile eins Zeile zwei.');
  });
});
