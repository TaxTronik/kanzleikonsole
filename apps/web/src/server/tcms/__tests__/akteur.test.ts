// TCMS Stufe 2: Anzeigename für `nam` (Vertrag: getrimmt, 1–200 Zeichen).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));

import { AkteurClaimsSchema } from '@taxtronik/tcms-contract';
import { TcmsAkteurVerweigert, anzeigename } from '../akteur';

describe('anzeigename', () => {
  it('trimmt und kürzt auf 200 Codeeinheiten, ohne ein Surrogatpaar zu teilen', () => {
    expect(anzeigename('  StB Dr. Anna Roth  ')).toBe('StB Dr. Anna Roth');
    expect(anzeigename('x'.repeat(250))).toHaveLength(200);
    const emoji = `${'x'.repeat(199)}😀`;
    expect(anzeigename(emoji)).toBe('x'.repeat(199));
    expect(AkteurClaimsSchema.shape.nam.safeParse(anzeigename('ä'.repeat(300))).success).toBe(true);
  });

  it('verweigert leere Namen statt einen Platzhalter zu senden', () => {
    for (const leer of ['', '   ', '\n\t']) {
      expect(() => anzeigename(leer)).toThrow(TcmsAkteurVerweigert);
    }
  });
});
