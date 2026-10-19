// TCMS Stufe 3, Bereich B: Lesen der Formulare des Länder-Monitors. Geprüft
// wird nur die Form wie im Vertrag; ob ein Stand in der Zukunft liegt oder ein
// Land im Monitor ist, prüft der Dienst.
// Fachkatalog: TCMS-DIENST-001
import { MAX_LAND_EUR } from '@taxtronik/tcms-contract';
import { describe, expect, it } from 'vitest';
import { betragAus, laenderAusFormular } from '../laender-formular';

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

describe('betragAus', () => {
  it.each([
    ['', 0],
    ['   ', 0],
    ['0', 0],
    ['1234', 1234],
    ['12.345,67', 12345.67],
    ['12345,67', 12345.67],
    ['10.000', 10000],
    ['1.000.000', 1000000],
    ['1234.5', 1234.5],
    ['1.5', 1.5],
    ['12 345,00 €', 12345],
    ['12 345 €', 12345],
  ])('„%s“ → %s', (roh, wert) => {
    expect(betragAus(roh)).toBe(wert);
  });

  it.each(['1,234.56', '1.23.4', '12,34,5', '-5', '1e5', 'abc', '1.2345,6', ',5', '5,'])(
    '„%s“ ist ungültig (nicht still falsch gelesen)',
    (roh) => {
      expect(betragAus(roh)).toBeNaN();
    },
  );
});

describe('laenderAusFormular', () => {
  it('Einzelerfassung: genau ein Land, Felder ohne Präfix, Haken und optionale Felder', () => {
    const r = laenderAusFormular(
      formular([
        ['datenstand', ' 2026-09-30 '],
        ['land', 'FR'],
        ['fernverkaeufeLfdEur', '10.000'],
        ['fernverkaeufeVorjahrEur', '0'],
        ['lagerSeit', '2026-03'],
        ['zmRelevant', 'on'],
        ['steuersaetzeGeprueftAm', '2026-09-01'],
      ]),
      { praefix: false },
    );
    expect(r).toEqual({
      ok: true,
      data: {
        datenstand: '2026-09-30',
        laender: [
          {
            land: 'FR',
            fernverkaeufeLfdEur: 10000,
            fernverkaeufeVorjahrEur: 0,
            lagerSeit: '2026-03',
            oss: false,
            lokaleUstNr: false,
            zmRelevant: true,
            steuersaetzeGeprueftAm: '2026-09-01',
          },
        ],
      },
    });
  });

  it.each([
    [[], 'kein Land'],
    [['fr'], 'Kleinbuchstaben'],
    [['FRA'], 'drei Zeichen'],
    [['FR', 'FR'], 'doppelt'],
  ])('ungültige Länderauswahl (%s: %s) → Feldfehler „land“', (laender) => {
    const r = laenderAusFormular(
      formular([
        ['datenstand', '2026-09-30'],
        ...laender.map((l): [string, string] => ['land', l]),
      ]),
      { praefix: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors ?? {})).toContain('land');
  });

  it('höchstens 40 Länder je Erfassung', () => {
    const codes: string[] = [];
    for (let a = 65; codes.length < 41; a++) {
      for (let b = 65; b < 91 && codes.length < 41; b++) codes.push(String.fromCharCode(a, b));
    }
    const r = laenderAusFormular(
      formular([['datenstand', '2026-09-30'], ...codes.map((l): [string, string] => ['land', l])]),
      { praefix: true },
    );
    expect(r.ok).toBe(false);
  });

  it('Feldfehler je Land mit Präfix, Stand und Formate', () => {
    const r = laenderAusFormular(
      formular([
        ['datenstand', '30.09.2026'],
        ['land', 'IT'],
        ['IT.fernverkaeufeLfdEur', '1,234.56'],
        ['IT.fernverkaeufeVorjahrEur', String(MAX_LAND_EUR + 1)],
        ['IT.lagerSeit', '2026-13'],
        ['IT.steuersaetzeGeprueftAm', '2026-02-30'],
      ]),
      { praefix: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors ?? {}).sort()).toEqual([
        'IT.fernverkaeufeLfdEur',
        'IT.fernverkaeufeVorjahrEur',
        'IT.lagerSeit',
        'IT.steuersaetzeGeprueftAm',
        'datenstand',
      ]);
    }
  });
});
