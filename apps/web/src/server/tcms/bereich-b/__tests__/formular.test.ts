// TCMS Stufe 3, Bereich B: Feldschemas der Aktionen. Geprüft wird nur die
// Form wie im Vertrag; fachliche Regeln (Vier-Augen, Status) prüft der Dienst.
// Fachkatalog: TCMS-DIENST-001
import { MIN_BEGRUENDUNG } from '@taxtronik/tcms-domain';
import { describe, expect, it } from 'vitest';
import { BegruendungFeld, ObjektIdFeld, OptionaleBegruendungFeld } from '../formular';

describe('Feldschemas', () => {
  it('Begründung: getrimmt, Mindest- und Höchstlänge wie im Vertrag', () => {
    const genau = 'x'.repeat(MIN_BEGRUENDUNG);
    expect(BegruendungFeld.parse(`  ${genau}  `)).toBe(genau);
    expect(BegruendungFeld.safeParse(` ${'x'.repeat(MIN_BEGRUENDUNG - 1)} `).success).toBe(false);
    expect(BegruendungFeld.safeParse('x'.repeat(2001)).success).toBe(false);
    expect(BegruendungFeld.safeParse('x'.repeat(2000)).success).toBe(true);
  });

  it('optionale Begründung: leer → undefined, sonst wie Pflichtbegründung', () => {
    expect(OptionaleBegruendungFeld.parse('')).toBeUndefined();
    expect(OptionaleBegruendungFeld.parse(null)).toBeUndefined();
    expect(OptionaleBegruendungFeld.safeParse('kurz').success).toBe(false);
  });

  it('Objekt-ID wie im Vertrag', () => {
    expect(ObjektIdFeld.safeParse('cmvf9kyul0009wb7dw9t9diqc').success).toBe(true);
    expect(ObjektIdFeld.safeParse('../x').success).toBe(false);
    expect(ObjektIdFeld.safeParse('x'.repeat(65)).success).toBe(false);
  });
});
