// TCMS Stufe 3, Bereich B: Feldschemas der Aktionen. Geprüft wird nur die
// Form wie im Vertrag; fachliche Regeln (Vier-Augen, Status) prüft der Dienst.
// Fachkatalog: TCMS-DIENST-001
import { TEXT_UNZULAESSIG_MELDUNG } from '@taxtronik/tcms-contract';
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

  it('Basisregel der Freitexte (TCMS s8): NUL und einzelne Surrogate als Feldfehler mit dem Text des Vertrags', () => {
    const basis = 'x'.repeat(MIN_BEGRUENDUNG);
    for (const schlecht of [`${basis}\u0000`, `${basis}${String.fromCharCode(0xd83d)}`]) {
      for (const schema of [BegruendungFeld, OptionaleBegruendungFeld]) {
        const r = schema.safeParse(schlecht);
        expect(r.success).toBe(false);
        expect(r.error?.issues[0]?.message).toBe(TEXT_UNZULAESSIG_MELDUNG);
      }
    }
    // Zeilenumbrüche und sichtbare Sonderzeichen bleiben erlaubt (Freitext).
    expect(
      BegruendungFeld.safeParse(`${basis}\nZweite Zeile ${String.fromCodePoint(0x1f600)}`).success,
    ).toBe(true);
  });

  it('Objekt-ID wie im Vertrag', () => {
    expect(ObjektIdFeld.safeParse('cmvf9kyul0009wb7dw9t9diqc').success).toBe(true);
    expect(ObjektIdFeld.safeParse('../x').success).toBe(false);
    expect(ObjektIdFeld.safeParse('x'.repeat(65)).success).toBe(false);
  });
});
