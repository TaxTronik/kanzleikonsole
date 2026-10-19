// TCMS s7: Klassifikation eines gesperrten Schritts der Feststellung (400 mit
// felder.von). Angezeigt wird nur ein Text der kanzleikonsole: der Sperrgrund
// der vendorten Domain oder ein fester Rückfall – nie der Text des Dienstes.
// Fachkatalog: TCMS-DIENST-001
import { describe, expect, it } from 'vitest';
import {
  WEITER_GESPERRT_RUECKFALL,
  WEITER_SPERRGRUENDE_FUER_TESTS,
  weiterGesperrtText,
} from '../weiter';

describe('weiterGesperrtText', () => {
  it('zählt die vier Sperrgründe der Domain auf', () => {
    expect([...WEITER_SPERRGRUENDE_FUER_TESTS].sort()).toEqual(
      [
        '§-153-Würdigung durch Berufsträger steht aus',
        'mindestens eine Maßnahme anlegen',
        'Nachkontrolle ohne Befund und gegengezeichnet fehlt',
        'offene Maßnahmen erledigen',
      ].sort(),
    );
  });

  it('bildet jeden bekannten Grund auf den Text der Domain ab', () => {
    for (const g of WEITER_SPERRGRUENDE_FUER_TESTS) {
      expect(weiterGesperrtText({ von: [`Noch nicht möglich: ${g}.`] })).toBe(
        `Noch nicht möglich: ${g}.`,
      );
    }
  });

  it('unbekannter Text → fester Rückfall; ohne `von` → null', () => {
    expect(weiterGesperrtText({ von: ['<script>Rohtext</script>'] })).toBe(
      WEITER_GESPERRT_RUECKFALL,
    );
    expect(weiterGesperrtText({ von: [] })).toBe(WEITER_GESPERRT_RUECKFALL);
    expect(weiterGesperrtText({ titel: ['x'] })).toBeNull();
    // Prototyp-Schlüssel zählen nicht als Feld.
    expect(
      weiterGesperrtText(Object.create({ von: ['x'] }) as Record<string, string[]>),
    ).toBeNull();
  });
});
