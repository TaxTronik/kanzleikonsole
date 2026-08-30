import { describe, expect, it } from 'vitest';
import {
  gwgPersonGeneralStateReducer,
  initialGwgPersonGeneralState,
  rebaseGwgPersonGeneralDraft,
} from '../person-general-conflict';

// Fachkatalog: GWG-BENEFICIAL-OWNERS-001,
// GWG-REPRESENTATIVE-AUTHORITY-001, GWG-IDENTIFICATION-EVIDENCE-001
describe('automatischer Abgleich allgemeiner GwG-Personenangaben', () => {
  it('übernimmt neue Serverwerte für unberührte Felder und erhält lokale Eingaben', () => {
    const base = {
      fullName: 'Erika Muster',
      birthDate: '1980-01-02',
      birthPlace: 'Bonn',
      residence: 'Musterstraße 1, 10115 Berlin',
      nationality: 'deutsch',
      isPep: false,
    };

    expect(
      rebaseGwgPersonGeneralDraft(
        base,
        {
          ...base,
          residence: 'Neue Straße 5, 10117 Berlin',
          nationality: 'österreichisch',
        },
        {
          ...base,
          birthPlace: 'Köln',
          nationality: 'schweizerisch',
          isPep: true,
        },
      ),
    ).toEqual({
      fullName: 'Erika Muster',
      birthDate: '1980-01-02',
      birthPlace: 'Köln',
      residence: 'Neue Straße 5, 10117 Berlin',
      nationality: 'österreichisch',
      isPep: true,
    });
  });

  it('behält im offenen Formular die alte Revision bis zur Konfliktantwort und zieht sie dann nach', () => {
    const base = {
      fullName: 'Erika Muster',
      birthDate: '1980-01-02',
      birthPlace: 'Bonn',
      residence: 'Musterstraße 1, 10115 Berlin',
      nationality: 'deutsch',
      isPep: false,
    };
    const latest = { ...base, birthPlace: 'Köln', isPep: true };
    let state = initialGwgPersonGeneralState(base, 'revision-alt');
    state = gwgPersonGeneralStateReducer(state, { type: 'start-editing' });
    state = gwgPersonGeneralStateReducer(state, {
      type: 'patch-draft',
      patch: { residence: 'Neue Straße 5, 10117 Berlin' },
    });
    state = gwgPersonGeneralStateReducer(state, {
      type: 'server-state',
      value: latest,
      revision: 'revision-neu',
    });

    expect(state.revision).toBe('revision-alt');
    expect(state.draftValue.residence).toBe('Neue Straße 5, 10117 Berlin');

    state = gwgPersonGeneralStateReducer(state, {
      type: 'conflict',
      latest,
      revision: 'revision-neu',
    });

    expect(state.revision).toBe('revision-neu');
    expect(state.draftValue).toMatchObject({
      birthPlace: 'Köln',
      residence: 'Neue Straße 5, 10117 Berlin',
      isPep: true,
    });
    expect(state.conflictNotice).toContain('automatisch eingearbeitet');

    state = gwgPersonGeneralStateReducer(state, { type: 'dismiss-conflict' });
    expect(state.conflictNotice).toBeNull();
  });
});
