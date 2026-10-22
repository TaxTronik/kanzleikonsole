import { describe, expect, it } from 'vitest';
// Fachkatalog: GWG-OCR-ASSIST-001
import { mrzCheckDigit, parseGermanTd1 } from '../identity-mrz';
import { grayscaleInPlace, ocrScale, stretchContrastInPlace } from '../identity-image';

// Maschinenlesbare Zone des veröffentlichten Musterausweises (Erika Mustermann).
const LINE1 = 'IDD<<LZ6311T475<<<<<<<<<<<<<<<';
const LINE2 = '8308126<3405019D<<2405<<<<<<<3';
const LINE3 = 'MUSTERMANN<<ERIKA<<<<<<<<<<<<<';

describe('GWG-OCR-ASSIST-001 maschinenlesbare Zone (TD1)', () => {
  it('liest das Muster mit gültigen Einzel- und Gesamtprüfziffern', () => {
    expect(mrzCheckDigit('LZ6311T47')).toBe('5');
    expect(parseGermanTd1([LINE1, LINE2, LINE3])).toEqual({
      documentNumber: 'LZ6311T47',
      birthDate: '830812',
      expiryDate: '340501',
      nationality: 'D',
      surname: 'MUSTERMANN',
      givenNames: 'ERIKA',
      compositeValid: true,
    });
  });

  it('übersteht als Buchstaben gelesene Füllzeichen und Leerzeichen (echte OCR-Ausgabe)', () => {
    const mrz = parseGermanTd1([
      'IDDKKLZ6311T475<<<<K<<<KLKLKLK<LK<LKLKKLKLK',
      '8308126<3405019D<<2405<<<<<<<3',
      'MUSTERMANN<<ERIKASS<S<SSSSSSSES<<',
    ]);
    expect(mrz).toMatchObject({
      documentNumber: 'LZ6311T47',
      birthDate: '830812',
      expiryDate: '340501',
      compositeValid: true,
      surname: 'MUSTERMANN',
    });
    // Ohne saubere Zeile 3 bleibt der Name unsicher (Füllzeichen als „SS“).
    expect(mrz?.givenNames).toBe('ERIKASS');
    // Liefert eine zweite Lesart (eigene Zone) eine sauberere Namenszeile, gewinnt sie.
    expect(
      parseGermanTd1([
        'IDD<<LZ6311T475<<<<<<<<<<<<<<<',
        '8308126<3405019D<<2405<<<<<<<3',
        'MUSTERMANN<<ERIKASS<S<SSSSSSSES<<',
        'IDD<<LZ6311T475<<<<<<<<<<<<<<<',
        '8308126<3405019D<<2405<<<<<<KK3',
        'MUSTERMANN<<ERIKA<<<<<<<<<<<<<',
      ])?.givenNames,
    ).toBe('ERIKA');
  });

  it('korrigiert T/7 in der Ausweisnummer nur, wenn genau eine Lesart die Prüfziffern erfüllt', () => {
    const misread = LINE1.replace('LZ6311T47', 'LZ6311747');
    expect(mrzCheckDigit('LZ6311747')).not.toBe('5');
    expect(parseGermanTd1([misread, LINE2, LINE3])).toMatchObject({
      documentNumber: 'LZ6311T47',
      compositeValid: true,
    });
    // Ziffernfelder: O/I/S als 0/1/5 gelesen.
    expect(parseGermanTd1([LINE1, '83O8126<34O5O19D<<2405<<<<<<<3', LINE3])?.birthDate).toBe(
      '830812',
    );
  });

  it('bevorzugt die gelesene Fassung, wenn auch eine verwechselbare Lesart die Prüfziffer erfüllt', () => {
    // Ein einzelner T/7-Tausch ändert die Prüfziffer immer (22 × Gewicht 7, 3
    // oder 1 ist nie durch 10 teilbar). Zwei Tausche an Stellen mit den
    // Gewichten 7 und 3 heben sich auf (22 × 10): Positionen 4 und 5.
    const read = 'L0X77K4X1';
    expect(mrzCheckDigit(read)).toBe(mrzCheckDigit('L0XTTK4X1'));
    // Zeile 2 mit 29 Zeichen: Gesamtprüfziffer unlesbar, nur die Einzelprüfziffer zählt.
    const mrz = parseGermanTd1([
      `IDD<<${read}${mrzCheckDigit(read)}`.padEnd(30, '<'),
      `830812${mrzCheckDigit('830812')}<340501${mrzCheckDigit('340501')}D<<`.padEnd(29, '<'),
    ]);
    expect(mrz?.documentNumber).toBe(read);
    expect(mrz?.compositeValid).toBe(false);
  });

  it('übernimmt nichts ohne gültige Prüfziffer', () => {
    expect(
      parseGermanTd1([LINE1.replace('T475', 'T479'), LINE2.replace('8308126', '8308121')]),
    ).toEqual(expect.objectContaining({ expiryDate: '340501' }));
    const broken = parseGermanTd1([
      LINE1.replace('T475', 'T479'),
      LINE2.replace('8308126', '8308121').replace('3405019', '3405011'),
    ]);
    expect(broken).toBeNull();
    expect(parseGermanTd1(['PERSONALAUSWEIS', 'ERIKA MUSTERMANN'])).toBeNull();
  });

  it('nimmt den Namen nur aus der Zeile nach Zeile 2, nicht aus der Nummernzeile darüber', () => {
    const mrz = parseGermanTd1([
      'VENEN<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<',
      LINE1,
      LINE2,
      'MUSTERMANNK<KERIKA<K<LK<LKLLKLKLKLKLKLKLKKLKL',
    ]);
    expect(mrz).toMatchObject({ documentNumber: 'LZ6311T47', compositeValid: true });
    expect(mrz?.surname).toBeUndefined();
    // Echte Ausgabe nach Kontraststreckung: Füllzeichen als S, Name sauber.
    expect(parseGermanTd1([LINE1, LINE2, 'MUSTERMANN<<ERIKA<S<<<S<<<<S<<<<<'])?.givenNames).toBe(
      'ERIKA',
    );
  });
});

describe('GWG-OCR-ASSIST-001 Bildaufbereitung nur für die Erkennung', () => {
  it('vergrößert kleine Aufnahmen höchstens doppelt und hält die Pixelgrenze ein', () => {
    expect(ocrScale(1011, 638)).toBeCloseTo(2000 / 1011, 5);
    expect(ocrScale(500, 300)).toBe(2);
    expect(ocrScale(4000, 3000)).toBe(1);
    expect(ocrScale(5000, 4000)).toBeCloseTo(Math.sqrt(12_000_000 / 20_000_000), 5);
  });
  it('wandelt in Graustufen um und lässt Transparenz unverändert', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 128, 0, 0, 255, 255]);
    grayscaleInPlace(data);
    expect([...data]).toEqual([76, 76, 76, 128, 29, 29, 29, 255]);
  });
  it('streckt den Kontrast auf das 1.–99. Perzentil', () => {
    // 100 Pixel: Werte 100..199 → auf 0..255 gespreizt (Ränder abgeschnitten).
    const data = new Uint8ClampedArray(400);
    for (let pixel = 0; pixel < 100; pixel++) data.fill(100 + pixel, pixel * 4, pixel * 4 + 3);
    stretchContrastInPlace(data);
    expect(data[0]).toBe(0);
    expect(data[99 * 4]).toBe(255);
    expect(data[50 * 4]).toBe(Math.round((150 - 100) * (255 / 99)));
    // Einfarbig: unverändert.
    const flat = new Uint8ClampedArray([80, 80, 80, 255, 80, 80, 80, 255]);
    stretchContrastInPlace(flat);
    expect([...flat]).toEqual([80, 80, 80, 255, 80, 80, 80, 255]);
  });
});
