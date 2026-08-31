'use client';

import { useEffect, useReducer, useRef } from 'react';

export interface IdentityReviewEditableFields {
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  number: string;
  issuedBy: string;
  issueDate: string;
  expiryDate: string;
}

export interface IdentityReviewLocalState {
  revision: string;
  fields: IdentityReviewEditableFields;
  selectedSubjectKey: string;
  ownerName: string;
  confirmedRevision: string | null;
}

export interface IdentityReviewSavedState extends IdentityReviewEditableFields {
  subjectKey: string;
  ownerName: string;
}

export interface IdentityReviewMachineState {
  local: IdentityReviewLocalState;
  lastServerRevision: string;
  supersededRevisions: string[];
}

export type IdentityReviewMachineAction =
  | { type: 'patch-fields'; patch: Partial<IdentityReviewEditableFields> }
  | { type: 'select-subject'; subjectKey: string }
  | {
      type: 'save-succeeded';
      saved: IdentityReviewSavedState;
      revision: string;
      submittedRevision: string | null;
      verified: boolean;
    }
  | { type: 'server-state'; incoming: IdentityReviewLocalState }
  | { type: 'reconcile-subjects'; subjectKeys: string[] };

export function applyIdentityReviewSave(
  saved: IdentityReviewSavedState,
  revision: string,
  verified = false,
): IdentityReviewLocalState {
  return {
    revision,
    fields: {
      type: saved.type,
      number: saved.number,
      issuedBy: saved.issuedBy,
      issueDate: saved.issueDate,
      expiryDate: saved.expiryDate,
    },
    selectedSubjectKey: saved.subjectKey,
    ownerName: saved.ownerName,
    confirmedRevision: verified ? revision : null,
  };
}

export function reconcileIdentityReviewServerState(
  current: IdentityReviewLocalState,
  incoming: IdentityReviewLocalState,
  supersededRevisions: ReadonlySet<string>,
): IdentityReviewLocalState {
  if (incoming.revision === current.revision || supersededRevisions.has(incoming.revision)) {
    return current;
  }
  return incoming;
}

function rememberRevisions(current: string[], revisions: Array<string | null>): string[] {
  const next = new Set(current);
  for (const revision of revisions) if (revision) next.add(revision);
  return [...next].slice(-20);
}

export function identityReviewStateReducer(
  state: IdentityReviewMachineState,
  action: IdentityReviewMachineAction,
): IdentityReviewMachineState {
  switch (action.type) {
    case 'patch-fields':
      return {
        ...state,
        local: { ...state.local, fields: { ...state.local.fields, ...action.patch } },
      };
    case 'select-subject':
      return { ...state, local: { ...state.local, selectedSubjectKey: action.subjectKey } };
    case 'save-succeeded':
      return {
        ...state,
        local: applyIdentityReviewSave(action.saved, action.revision, action.verified),
        supersededRevisions: rememberRevisions(state.supersededRevisions, [
          action.submittedRevision,
          state.local.revision,
        ]),
      };
    case 'server-state': {
      if (state.lastServerRevision === action.incoming.revision) return state;
      const local = reconcileIdentityReviewServerState(
        state.local,
        action.incoming,
        new Set(state.supersededRevisions),
      );
      return {
        local,
        lastServerRevision: action.incoming.revision,
        supersededRevisions:
          local === state.local
            ? state.supersededRevisions
            : rememberRevisions(state.supersededRevisions, [state.local.revision]),
      };
    }
    case 'reconcile-subjects': {
      const selectedSubjectKey = action.subjectKeys.includes(state.local.selectedSubjectKey)
        ? state.local.selectedSubjectKey
        : action.subjectKeys.length === 1
          ? action.subjectKeys[0]!
          : '';
      return selectedSubjectKey === state.local.selectedSubjectKey
        ? state
        : { ...state, local: { ...state.local, selectedSubjectKey } };
    }
  }
}

interface IdentityReviewActionState {
  ok: boolean;
  reviewReset?: boolean;
  revision?: string;
  saved?: IdentityReviewSavedState;
  verified?: boolean;
}

export function useIdentityReviewState(options: {
  initial: IdentityReviewLocalState;
  incoming: IdentityReviewLocalState;
  subjectKeys: string[];
  actionState: IdentityReviewActionState | null;
  onAcknowledgeInvalidation: (generation: number) => void;
  onReviewReset: () => void;
}) {
  const { initial, incoming, subjectKeys, actionState, onAcknowledgeInvalidation, onReviewReset } =
    options;
  const [machine, dispatch] = useReducer(identityReviewStateReducer, {
    local: initial,
    lastServerRevision: initial.revision,
    supersededRevisions: [],
  });
  const handledActionState = useRef<IdentityReviewActionState | null>(null);
  const submitted = useRef<{ revision: string; invalidationGeneration: number | null } | null>(
    null,
  );

  useEffect(() => {
    if (handledActionState.current === actionState) return;
    handledActionState.current = actionState;
    if (!actionState?.ok) return;
    if (actionState.saved && actionState.revision) {
      dispatch({
        type: 'save-succeeded',
        saved: actionState.saved,
        revision: actionState.revision,
        submittedRevision: submitted.current?.revision ?? null,
        verified: actionState.verified === true,
      });
    }
    if (submitted.current?.invalidationGeneration !== null && submitted.current) {
      onAcknowledgeInvalidation(submitted.current.invalidationGeneration);
    }
    submitted.current = null;
    if (actionState.reviewReset) onReviewReset();
  }, [actionState, onAcknowledgeInvalidation, onReviewReset]);

  useEffect(() => {
    dispatch({ type: 'server-state', incoming });
  }, [incoming]);

  useEffect(() => {
    dispatch({ type: 'reconcile-subjects', subjectKeys });
  }, [subjectKeys]);

  return {
    localState: machine.local,
    patchFields(patch: Partial<IdentityReviewEditableFields>) {
      dispatch({ type: 'patch-fields', patch });
    },
    selectSubject(subjectKey: string) {
      dispatch({ type: 'select-subject', subjectKey });
    },
    markSubmitted(revision: string, invalidationGeneration: number | null) {
      submitted.current = { revision, invalidationGeneration };
    },
  };
}
