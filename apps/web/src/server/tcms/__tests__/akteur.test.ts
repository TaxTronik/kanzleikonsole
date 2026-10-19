// TCMS Stufe 2: Anzeigename für `nam` (Vertrag: getrimmt, 1–200 Zeichen); seit
// TCMS s8 mit der Zeichenregel des Vertrags (der Dienst prüft `nam` nicht).
// Fachkatalog: TCMS-AKTEUR-001
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));

import { AkteurClaimsSchema, einzeilig, UNZULAESSIGE_ZEICHEN } from '@taxtronik/tcms-contract';
import { TcmsAkteurVerweigert, anzeigename } from '../akteur';

describe('anzeigename', () => {
  it('trimmt und kürzt auf 200 Codeeinheiten, ohne ein Surrogatpaar zu teilen', () => {
    expect(anzeigename('  StB Dr. Anna Roth  ')).toBe('StB Dr. Anna Roth');
    expect(anzeigename('x'.repeat(250))).toHaveLength(200);
    const emoji = `${'x'.repeat(199)}😀`;
    expect(anzeigename(emoji)).toBe('x'.repeat(199));
    expect(AkteurClaimsSchema.shape.nam.safeParse(anzeigename('ä'.repeat(300))).success).toBe(true);
  });

  it('bereinigt mit der Zeichenregel des Vertrags (Richtung, Nullbreite, Selektoren, Tags, Zeilen)', () => {
    const z = (...cps: number[]) => String.fromCodePoint(...cps);
    const roh = `Anna${z(0x202e)} Roth${z(0x200b, 0x00ad)}\r\nStB ${z(0x2764, 0xfe0f, 0x034f, 0x180b, 0xe0041, 0x200e, 0x061c)}`;
    const name = anzeigename(roh);
    expect(name).toBe(`Anna Roth StB ${z(0x2764)}`);
    expect(UNZULAESSIGE_ZEICHEN.test(name)).toBe(false);
    // Auch als Name in Bodies des Vertrags gültig (namensEintrag, AufnahmePerson).
    expect(einzeilig(1, 200).safeParse(name).success).toBe(true);
  });

  it('verweigert leere Namen statt einen Platzhalter zu senden', () => {
    for (const leer of ['', '   ', '\n\t', String.fromCodePoint(0x200b, 0xfe0f)]) {
      expect(() => anzeigename(leer)).toThrow(TcmsAkteurVerweigert);
    }
  });
});
