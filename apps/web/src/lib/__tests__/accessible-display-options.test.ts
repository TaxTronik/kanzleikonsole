import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_OPTIONS,
  displayOptionsFromProfile,
  displayOptionsToColumns,
  parseDisplayOptionsPatch,
} from '../accessible-display-options';

describe('persönliche Anzeigeoptionen ohne fachliche Auswirkung', () => {
  it.each([
    null,
    undefined,
    true,
    false,
    '',
    [],
    {},
    { fontSize: 'huge' },
    { reduceMotion: 'false' },
    { contrast: 'none' },
    { spacing: 2 },
    { tenantId: 'other' },
    { fontSize: 'large', actorId: 'other' },
  ])('verwirft ungültige oder fremde Felder: %j', (input) => {
    expect(parseDisplayOptionsPatch(input)).toBeNull();
  });

  it('validiert jeden erlaubten Wert einschließlich false und kombinierter Änderungen', () => {
    for (const fontSize of ['standard', 'large', 'extra-large']) {
      for (const spacing of ['normal', 'relaxed', 'wide']) {
        for (const contrast of ['standard', 'strong']) {
          for (const reduceMotion of [true, false]) {
            const patch = { fontSize, spacing, contrast, reduceMotion };
            expect(parseDisplayOptionsPatch(patch)).toEqual(patch);
          }
        }
      }
    }
  });

  it('ordnet ausschließlich angeforderte Anzeigeoptionen ihren eigenen DB-Spalten zu', () => {
    expect(displayOptionsToColumns({ fontSize: 'extra-large' })).toEqual({
      accessibleDisplayFontSize: 'extra-large',
    });
    expect(displayOptionsToColumns({ reduceMotion: false })).toEqual({
      accessibleDisplayReduceMotion: false,
    });
    expect(displayOptionsToColumns({ spacing: 'wide', contrast: 'standard' })).toEqual({
      accessibleDisplaySpacing: 'wide',
      accessibleDisplayContrast: 'standard',
    });
  });

  it('behält bekannte Werte und ersetzt nur fehlende/ungültige Werte durch sichere Defaults', () => {
    expect(displayOptionsFromProfile(null)).toEqual(DEFAULT_DISPLAY_OPTIONS);
    expect(
      displayOptionsFromProfile({
        accessibleDisplayFontSize: 'extra-large',
        accessibleDisplaySpacing: 'invalid',
        accessibleDisplayContrast: 0,
        accessibleDisplayReduceMotion: false,
      }),
    ).toEqual({ ...DEFAULT_DISPLAY_OPTIONS, fontSize: 'extra-large', reduceMotion: false });
  });

  it('übernimmt weder CSS noch Prototyp-Schlüssel aus einer Eingabe', () => {
    expect(parseDisplayOptionsPatch(JSON.parse('{"__proto__":{"fontSize":"large"}}'))).toBeNull();
    expect(parseDisplayOptionsPatch({ style: 'display:none' })).toBeNull();
  });
});
