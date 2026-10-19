// TCMS s8 (RT4-T-01/-03/-08): eine Zeichenregel für alle Texte an das Tax-CMS.
// Stammdaten der kanzleikonsole werden still bereinigt; das Ergebnis besteht
// immer die Schemas des Vertrags. Eingaben des Menschen werden nicht still
// geändert – dafür liefert die Datei die festen Meldungen des Vertrags.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import {
  DATEINAME_UNZULAESSIG,
  einzeilig,
  TEXT_UNZULAESSIG,
  TEXT_UNZULAESSIG_MELDUNG,
  UNZULAESSIGE_ZEICHEN,
} from '@taxtronik/tcms-contract';
import { describe, expect, it } from 'vitest';
import {
  tcmsKuerzen,
  tcmsTextBereinigen,
  VERTRAG_ZEICHEN_MELDUNGEN,
  vertragsZeichenMeldung,
} from '../zeichen';

const Z = (cp: number) => String.fromCodePoint(cp);
/** Zeichen, die der Vertrag in einzeiligen Texten und Dateinamen abweist (Auswahl der Aufgabe). */
const UNSICHTBAR = {
  lrm: Z(0x200e),
  rlm: Z(0x200f),
  alm: Z(0x061c),
  zwsp: Z(0x200b),
  shy: Z(0x00ad),
  rlo: Z(0x202e),
  cgj: Z(0x034f),
  fvs1: Z(0x180b),
  vs16: Z(0xfe0f),
  tagA: Z(0xe0041),
  tagEnde: Z(0xe007f),
  bom: Z(0xfeff),
  nul: Z(0x0000),
  del: Z(0x007f),
  ls: Z(0x2028),
};

describe('tcmsTextBereinigen', () => {
  it('EINZEILIG: entfernt jedes unsichtbare Zeichen der Regel, Trenner werden Leerzeichen', () => {
    for (const [name, zeichen] of Object.entries(UNSICHTBAR)) {
      const roh = `Tal${zeichen}wind GmbH`;
      expect(UNZULAESSIGE_ZEICHEN.test(roh), name).toBe(true);
      const sauber = tcmsTextBereinigen(roh, 'EINZEILIG', 200);
      expect(UNZULAESSIGE_ZEICHEN.test(sauber), name).toBe(false);
      expect(sauber, name).toBe(name === 'ls' ? 'Tal wind GmbH' : 'Talwind GmbH');
    }
    expect(tcmsTextBereinigen('Talwind\r\nOutdoor\tGmbH', 'EINZEILIG')).toBe(
      'Talwind Outdoor GmbH',
    );
  });

  it('EINZEILIG: Emoji mit Variantenselektor und Tag-Sequenz bleiben sichtbar, ohne die Selektoren', () => {
    const herz = `Shop ${Z(0x2764)}${UNSICHTBAR.vs16}`;
    expect(tcmsTextBereinigen(herz, 'EINZEILIG')).toBe(`Shop ${Z(0x2764)}`);
    // Flagge England: U+1F3F4 + Tag-Zeichen „gbeng“ + Tag-Ende
    const flagge = `${Z(0x1f3f4)}${[0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f].map(Z).join('')} Ltd`;
    expect(tcmsTextBereinigen(flagge, 'EINZEILIG')).toBe(`${Z(0x1f3f4)} Ltd`);
  });

  it('EINZEILIG: Ergebnis besteht das Schema des Vertrags; Kürzen trennt kein Ersatzpaar', () => {
    const roh = `${'a'.repeat(198)}${Z(0x1f600)}${UNSICHTBAR.rlo}xyz`;
    const sauber = tcmsTextBereinigen(roh, 'EINZEILIG', 199);
    expect(sauber).toBe('a'.repeat(198));
    expect(einzeilig(1, 200).safeParse(sauber).success).toBe(true);
    expect(tcmsKuerzen(`ab${Z(0x1f600)}cd`, 3)).toBe('ab');
    expect(tcmsKuerzen(`ab${Z(0x1f600)}cd`, 4)).toBe(`ab${Z(0x1f600)}`);
  });

  it('DATEINAME: zusätzlich ohne Pfadtrenner; Ergebnis besteht die Dateinamensregel', () => {
    const roh = `Re${UNSICHTBAR.rlo}chnung${UNSICHTBAR.zwsp}/2026\\Q3${UNSICHTBAR.vs16}.pdf`;
    const sauber = tcmsTextBereinigen(roh, 'DATEINAME', 255);
    expect(sauber).toBe('Rechnung_2026_Q3.pdf');
    expect(DATEINAME_UNZULAESSIG.test(sauber)).toBe(false);
  });

  it('FREITEXT: nur die Basisregel (NUL, einzelne Surrogate, seit TCMS s9 Richtungssteuerzeichen); Zeilen, LRM und ZWJ bleiben', () => {
    const roh = `Zeile 1\nZeile 2${UNSICHTBAR.nul}${String.fromCharCode(0xd800)} ${UNSICHTBAR.rlo}x\u2066y\u200e\u200d`;
    const sauber = tcmsTextBereinigen(roh, 'FREITEXT');
    expect(sauber).toBe('Zeile 1\nZeile 2 xy\u200e\u200d');
    expect(TEXT_UNZULAESSIG.test(sauber)).toBe(false);
  });
});

describe('Meldungen des Vertrags', () => {
  it('ermittelt die festen Zeichenmeldungen aus den Schemas des Vertrags', () => {
    expect([...VERTRAG_ZEICHEN_MELDUNGEN].sort()).toEqual(
      ['Steuerzeichen sind nicht erlaubt', TEXT_UNZULAESSIG_MELDUNG, 'Unzulässige Zeichen'].sort(),
    );
  });

  it('lässt nur diese Meldungen durch', () => {
    expect(vertragsZeichenMeldung('Unzulässige Zeichen')).toBe('Unzulässige Zeichen');
    expect(vertragsZeichenMeldung(TEXT_UNZULAESSIG_MELDUNG)).toBe(TEXT_UNZULAESSIG_MELDUNG);
    expect(vertragsZeichenMeldung('Too small: expected string to have >=5 characters')).toBeNull();
    expect(vertragsZeichenMeldung('<b>Rohtext des Dienstes</b>')).toBeNull();
  });
});
