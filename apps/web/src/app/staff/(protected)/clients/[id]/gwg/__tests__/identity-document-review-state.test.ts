import { describe, expect, it } from 'vitest';
import {
  applyIdentityReviewSave,
  identityReviewStateReducer,
  reconcileIdentityReviewServerState,
  type IdentityReviewLocalState,
  type IdentityReviewSavedState,
} from '../use-identity-review-state';

function localState(
  revision: string,
  overrides: Partial<IdentityReviewLocalState> = {},
): IdentityReviewLocalState {
  return {
    revision,
    fields: {
      type: 'PERSONALAUSWEIS',
      number: 'OLD-0',
      issuedBy: 'Behörde 0',
      issueDate: '2020-01-01',
      expiryDate: '2030-01-01',
    },
    selectedSubjectKey: 'representative:person-0',
    ownerName: 'Person 0',
    confirmedRevision: null,
    ...overrides,
  };
}

function saved(sequence: number): IdentityReviewSavedState {
  return {
    type: sequence === 1 ? 'REISEPASS' : 'PERSONALAUSWEIS',
    number: `NEW-${sequence}`,
    issuedBy: `Behörde ${sequence}`,
    issueDate: `202${sequence}-02-0${sequence}`,
    expiryDate: `203${sequence}-03-0${sequence}`,
    subjectKey: `representative:person-${sequence}`,
    ownerName: `Person ${sequence}`,
  };
}

describe('IdentityReviewCard revision state', () => {
  it('trägt zwei Saves vollständig und mit der jeweiligen Nachfolger-Revision fort', () => {
    const initial = localState('revision-0');
    const afterFirstSave = applyIdentityReviewSave(saved(1), 'revision-1');

    expect(afterFirstSave).toEqual({
      revision: 'revision-1',
      fields: {
        type: 'REISEPASS',
        number: 'NEW-1',
        issuedBy: 'Behörde 1',
        issueDate: '2021-02-01',
        expiryDate: '2031-03-01',
      },
      selectedSubjectKey: 'representative:person-1',
      ownerName: 'Person 1',
      confirmedRevision: 'revision-1',
    });

    const superseded = new Set([initial.revision, afterFirstSave.revision]);
    const afterSecondSave = applyIdentityReviewSave(saved(2), 'revision-2');

    expect(afterSecondSave.revision).toBe('revision-2');
    expect(afterSecondSave.fields).toEqual({
      type: 'PERSONALAUSWEIS',
      number: 'NEW-2',
      issuedBy: 'Behörde 2',
      issueDate: '2022-02-02',
      expiryDate: '2032-03-02',
    });
    expect(afterSecondSave.selectedSubjectKey).toBe('representative:person-2');
    expect(afterSecondSave.ownerName).toBe('Person 2');
    expect(afterSecondSave.confirmedRevision).toBe('revision-2');

    const delayedFirstRefresh = localState('revision-1', {
      fields: afterFirstSave.fields,
      selectedSubjectKey: afterFirstSave.selectedSubjectKey,
      ownerName: afterFirstSave.ownerName,
      confirmedRevision: null,
    });
    const delayedInitialRefresh = initial;

    expect(
      reconcileIdentityReviewServerState(afterSecondSave, delayedFirstRefresh, superseded),
    ).toBe(afterSecondSave);
    expect(
      reconcileIdentityReviewServerState(afterSecondSave, delayedInitialRefresh, superseded),
    ).toBe(afterSecondSave);
  });

  it('bewahrt neue lokale Eingaben bei gleicher RSC-Revision, übernimmt aber fremde Revisionen', () => {
    const locallyEdited = localState('revision-2', {
      fields: {
        ...localState('revision-2').fields,
        number: 'UNSAVED-LOCAL',
      },
      confirmedRevision: 'revision-2',
    });
    const matchingServerRefresh = localState('revision-2', {
      fields: {
        ...localState('revision-2').fields,
        number: 'SAVED-SERVER',
      },
    });

    expect(
      reconcileIdentityReviewServerState(locallyEdited, matchingServerRefresh, new Set()),
    ).toBe(locallyEdited);

    const externalUpdate = localState('revision-external', {
      fields: {
        ...localState('revision-external').fields,
        number: 'EXTERNAL',
      },
    });
    expect(
      reconcileIdentityReviewServerState(locallyEdited, externalUpdate, new Set(['revision-1'])),
    ).toBe(externalUpdate);
  });

  it('führt Edit, Save und verspätete Server-Revisionen deterministisch im Reducer', () => {
    const initial = localState('revision-0');
    const edited = identityReviewStateReducer(
      { local: initial, lastServerRevision: initial.revision, supersededRevisions: [] },
      { type: 'patch-fields', patch: { number: 'LOCAL' } },
    );
    expect(edited.local.fields.number).toBe('LOCAL');

    const afterSave = identityReviewStateReducer(edited, {
      type: 'save-succeeded',
      saved: saved(1),
      revision: 'revision-1',
      submittedRevision: 'revision-0',
    });
    expect(afterSave.local.revision).toBe('revision-1');
    expect(afterSave.supersededRevisions).toContain('revision-0');

    const delayed = identityReviewStateReducer(afterSave, {
      type: 'server-state',
      incoming: localState('revision-0'),
    });
    expect(delayed.local).toBe(afterSave.local);
  });
});
