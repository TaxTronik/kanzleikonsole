// TCMS s8: Entwurfsformular der Durchführung (Bereich C). Freitexte (Kommentare,
// Bemerkungen) prüfen die Basisregel des Vertrags als Feldfehler mit dessen
// Text statt still zu ändern; Kürzen trennt kein Ersatzpaar.
// Fachkatalog: TCMS-DIENST-001
import { TEXT_UNZULAESSIG, TEXT_UNZULAESSIG_MELDUNG } from '@taxtronik/tcms-contract';
import { describe, expect, it } from 'vitest';
import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { speichernAusFormular } from '../formular';

function formular(felder: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(felder)) fd.append(k, v);
  return fd;
}

describe('speichernAusFormular', () => {
  const d = tcmsFixtures.durchfuehrungMitBefund();

  it('NUL in Kommentar und Bemerkung: Feldfehler, kein Body', () => {
    // Einzelne Surrogate kommen über FormData nicht an (USVString: U+FFFD).
    expect(formular({ x: String.fromCharCode(0xd800) }).get('x')).toBe('\ufffd');
    const r = speichernAusFormular(
      formular({
        schritt_0_kommentar: 'Abgleich\u0000',
        [`bemerkung_${d.kontrolle.kennzahlen[0]!.key}`]: 'Hin\u0000weis',
        ergebnisKommentar: 'in Ordnung',
      }),
      d,
    );
    expect(r).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: {
        schritt_0_kommentar: [TEXT_UNZULAESSIG_MELDUNG],
        [`bemerkung_${d.kontrolle.kennzahlen[0]!.key}`]: [TEXT_UNZULAESSIG_MELDUNG],
      },
    });
  });

  it('Kürzen an der Höchstlänge trennt kein Ersatzpaar (sonst einzelnes Surrogat)', () => {
    const lang = `${'x'.repeat(1999)}${String.fromCodePoint(0x1f600)}`;
    const r = speichernAusFormular(formular({ schritt_0_kommentar: lang }), d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kommentar = r.eingabe.schritte[0]!.kommentar;
    expect(TEXT_UNZULAESSIG.test(kommentar)).toBe(false);
  });
});
