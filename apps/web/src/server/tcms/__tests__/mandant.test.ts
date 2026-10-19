// TCMS Stufe 3: einzeilige Felder des Mandantenankers. Steuer-, Richtungs- und
// Nullbreitenzeichen aus Stammdaten der kanzleikonsole dürfen weder den
// Vertrag verletzen (Anker scheitert) noch unsichtbar in Anzeigen des Dienstes
// landen (Trojan-Source-artige Umkehrungen, RT-Befund des TCMS-Vertrags).
// Die Abfrage selbst prüft namen-personen-db.test.ts gegen PostgreSQL.
// Fachkatalog: TCMS-AKTEUR-001
import { describe, expect, it } from 'vitest';
import { MandantAnkerBodySchema } from '@taxtronik/tcms-contract';
import { ankerName, einzeilig } from '../mandant';

const ZEICHEN = {
  bel: String.fromCharCode(0x07),
  rlo: String.fromCharCode(0x202e),
  lri: String.fromCharCode(0x2066),
  pdi: String.fromCharCode(0x2069),
  zwsp: String.fromCharCode(0x200b),
  bom: String.fromCharCode(0xfeff),
  shy: String.fromCharCode(0x00ad),
};

describe('einzeilig / ankerName', () => {
  it('ersetzt Steuer-, Richtungs- und Formatzeichen durch Leerzeichen', () => {
    const roh = `Tal${ZEICHEN.rlo}wind${ZEICHEN.bel}\n${ZEICHEN.lri}GmbH${ZEICHEN.pdi}${ZEICHEN.zwsp}${ZEICHEN.bom}${ZEICHEN.shy}`;
    const name = ankerName(roh);
    expect(name).toBe('Tal wind GmbH');
    expect(
      MandantAnkerBodySchema.safeParse({ name, rechtsform: 'GmbH', datevNr: null }).success,
    ).toBe(true);
  });

  it('kürzt nach Zeichen, ohne ein Ersatzpaar zu trennen', () => {
    expect(einzeilig('ab😀cd', 3)).toBe('ab');
    expect(einzeilig('ab😀cd', 4)).toBe('ab😀');
    expect(einzeilig('  a   b  ', 10)).toBe('a b');
    expect(ankerName('x'.repeat(300))).toHaveLength(200);
  });
});
