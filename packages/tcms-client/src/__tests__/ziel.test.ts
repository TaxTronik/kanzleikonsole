// TCMS Stufe 2: Request-Target, das der Client signiert und sendet.
import { describe, expect, it } from 'vitest';
import { TcmsUngueltig } from '../fehler';
import { baueZiel, kodiereQueryKomponente } from '../ziel';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const BASIS = 'http://127.0.0.1:3200';

/** Was fetch tatsächlich sendet: pathname + search nach dem WHATWG-Parser. */
function gesendet(target: string): string {
  const url = new URL(target, BASIS);
  return `${url.pathname}${url.search}`;
}

function lokalerFehler(run: () => unknown): TcmsUngueltig {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TcmsUngueltig);
    expect((error as TcmsUngueltig).lokal).toBe(true);
    return error as TcmsUngueltig;
  }
  throw new Error('kein Fehler');
}

// Werte, die der URL-Parser ohne Zusatzkodierung umschreiben würde (`'`) oder
// die als Trenner wirken (`&=#?+`), dazu Umlaute, Emoji und Prozentzeichen.
const SONDERWERTE = [
  "O'Brien",
  'Müller & Söhne',
  'a=b&c=d',
  '100 % sicher',
  '(GmbH) *Stern* !wichtig',
  'Frage? #Anker /Pfad\\Rück',
  'plus+zeichen ~tilde',
  'Grüße €, 😀',
  'ß',
  '',
];

describe('baueZiel', () => {
  it('kodiert Pfadparameter mit encodeURIComponent und erkennt den Mandantenpfad', () => {
    const ziel = baueZiel('/v1/mandanten/:mandantId/kontext', { mandantId: MANDANT });
    expect(ziel).toEqual({ target: `/v1/mandanten/${MANDANT}/kontext`, mandantId: MANDANT });
    expect(baueZiel('/v1/portfolio')).toEqual({ target: '/v1/portfolio', mandantId: null });
  });

  it('signiertes Target = gesendetes Target, auch mit Sonderzeichen in Query-Werten', () => {
    for (const wert of SONDERWERTE) {
      const { target } = baueZiel('/v1/audit', {}, { suche: wert, stand: '2026-10-16' });
      expect(gesendet(target), wert).toBe(target);
      // Der Dienst liest die Query mit URLSearchParams: derselbe Wert kommt an.
      const query = new URLSearchParams(target.slice(target.indexOf('?') + 1));
      expect(query.get('suche'), wert).toBe(wert);
      expect([...query.keys()]).toEqual(['suche', 'stand']);
    }
  });

  it("kodiert !'()* zusätzlich, weil der URL-Parser sonst nachkodiert", () => {
    expect(kodiereQueryKomponente("!'()*")).toBe('%21%27%28%29%2A');
    // Ohne die Zusatzkodierung wiche das gesendete vom signierten Target ab:
    const roh = `/v1/audit?suche=${encodeURIComponent("O'Brien")}`;
    expect(gesendet(roh)).not.toBe(roh);
  });

  it('lässt undefined-Werte weg und behält die Reihenfolge', () => {
    expect(baueZiel('/v1/audit', {}, { b: '2', a: undefined, c: '3' }).target).toBe(
      '/v1/audit?b=2&c=3',
    );
    expect(baueZiel('/v1/audit', {}, { a: undefined }).target).toBe('/v1/audit');
  });

  it('weist nicht kanonische Pfadparameter ab, statt sie zu senden', () => {
    for (const wert of ['..', '.', 'a.b', 'a/b', 'a b', 'ä', '%41', '']) {
      expect(
        lokalerFehler(() => baueZiel('/v1/mandanten/:mandantId/kontext', { mandantId: wert }))
          .felder,
        wert,
      ).toHaveProperty('params.mandantId');
    }
    expect(
      lokalerFehler(() => baueZiel('/v1/mandanten/:mandantId', { mandantId: '\ud800' })).felder,
    ).toEqual({ 'params.mandantId': ['kein gültiges Unicode'] });
  });

  it('verlangt jeden Pfadparameter genau einmal und keine überzähligen', () => {
    lokalerFehler(() => baueZiel('/v1/mandanten/:mandantId/kontext'));
    lokalerFehler(() => baueZiel('/v1/portfolio', { mandantId: MANDANT }));
    lokalerFehler(() => baueZiel('/v1/x/:a/:a', { a: 'b' }));
    lokalerFehler(() =>
      baueZiel('/v1/mandanten/:mandantId', Object.create({ mandantId: MANDANT }) as never),
    );
  });

  it('verlangt Muster unter /v1/ mit festen Segmenten wie die Routentabelle', () => {
    for (const muster of ['/v2/x', 'v1/x', '/v1/../x', '/v1/X', '/v1/a//b', '/v1/a?b=1']) {
      lokalerFehler(() => baueZiel(muster));
    }
  });

  it('prüft Query-Namen, Typen, Unicode und die Länge des Targets', () => {
    lokalerFehler(() => baueZiel('/v1/audit', {}, { __proto__x: '1', 'a-b': '1' }));
    lokalerFehler(() => baueZiel('/v1/audit', {}, { a: 1 as unknown as string }));
    lokalerFehler(() => baueZiel('/v1/audit', {}, { a: '\udc00' }));
    lokalerFehler(() => baueZiel('/v1/audit', {}, { a: 'x'.repeat(2048) }));
  });

  it('hält die Gleichheit für zufällige Unicode-Werte (fester Startwert)', () => {
    let zustand = 42;
    const zufall = () => {
      zustand = (zustand * 1103515245 + 12345) % 2 ** 31;
      return zustand;
    };
    for (let i = 0; i < 300; i++) {
      const laenge = zufall() % 12;
      let wert = '';
      for (let j = 0; j < laenge; j++) {
        const code = zufall() % 3 === 0 ? 0x20 + (zufall() % 0x60) : 0xa0 + (zufall() % 0x2000);
        wert += String.fromCodePoint(code);
      }
      const { target } = baueZiel('/v1/audit', {}, { q: wert });
      expect(gesendet(target)).toBe(target);
      expect(new URLSearchParams(target.split('?')[1]).get('q')).toBe(wert);
    }
  });
});
