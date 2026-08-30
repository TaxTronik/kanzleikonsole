import type { SavedGwgPersonGeneral } from './owner-actions';

const PERSON_GENERAL_FIELDS = [
  'fullName',
  'birthDate',
  'birthPlace',
  'residence',
  'nationality',
  'isPep',
] as const satisfies readonly (keyof SavedGwgPersonGeneral)[];

/**
 * Setzt einen lokalen Entwurf auf einen parallel geänderten Serverstand auf.
 * Unberührte Felder ziehen den neuen Serverwert nach; bewusst geänderte Felder
 * bleiben erhalten und können nach der automatischen Aktualisierung erneut
 * gespeichert werden.
 */
export function rebaseGwgPersonGeneralDraft(
  base: SavedGwgPersonGeneral,
  draft: SavedGwgPersonGeneral,
  latest: SavedGwgPersonGeneral,
): SavedGwgPersonGeneral {
  const rebased = { ...latest };
  for (const field of PERSON_GENERAL_FIELDS) {
    if (draft[field] !== base[field]) {
      Object.assign(rebased, { [field]: draft[field] });
    }
  }
  return rebased;
}

export interface GwgPersonGeneralLocalState {
  editing: boolean;
  displayValue: SavedGwgPersonGeneral;
  draftValue: SavedGwgPersonGeneral;
  editBase: SavedGwgPersonGeneral;
  revision: string;
  serverRevision: string;
  conflictNotice: string | null;
}

export type GwgPersonGeneralLocalAction =
  | { type: 'start-editing' }
  | { type: 'cancel-editing' }
  | { type: 'patch-draft'; patch: Partial<SavedGwgPersonGeneral> }
  | { type: 'save-succeeded'; saved: SavedGwgPersonGeneral; revision?: string }
  | { type: 'conflict'; latest: SavedGwgPersonGeneral; revision: string }
  | { type: 'dismiss-conflict' }
  | { type: 'server-state'; value: SavedGwgPersonGeneral; revision: string };

export function initialGwgPersonGeneralState(
  value: SavedGwgPersonGeneral,
  revision: string,
): GwgPersonGeneralLocalState {
  return {
    editing: false,
    displayValue: value,
    draftValue: value,
    editBase: value,
    revision,
    serverRevision: revision,
    conflictNotice: null,
  };
}

export function gwgPersonGeneralStateReducer(
  state: GwgPersonGeneralLocalState,
  action: GwgPersonGeneralLocalAction,
): GwgPersonGeneralLocalState {
  switch (action.type) {
    case 'start-editing':
      return {
        ...state,
        editing: true,
        draftValue: state.displayValue,
        editBase: state.displayValue,
        conflictNotice: null,
      };
    case 'cancel-editing':
      return {
        ...state,
        editing: false,
        draftValue: state.displayValue,
        editBase: state.displayValue,
        conflictNotice: null,
      };
    case 'patch-draft':
      return { ...state, draftValue: { ...state.draftValue, ...action.patch } };
    case 'save-succeeded': {
      const revision = action.revision ?? state.revision;
      return {
        editing: false,
        displayValue: action.saved,
        draftValue: action.saved,
        editBase: action.saved,
        revision,
        serverRevision: revision,
        conflictNotice: null,
      };
    }
    case 'conflict':
      return {
        ...state,
        displayValue: action.latest,
        draftValue: rebaseGwgPersonGeneralDraft(state.editBase, state.draftValue, action.latest),
        editBase: action.latest,
        revision: action.revision,
        serverRevision: action.revision,
        conflictNotice:
          'Der aktuelle Stand wurde automatisch eingearbeitet. Ihre Änderungen sind erhalten – bitte kurz prüfen und erneut speichern.',
      };
    case 'dismiss-conflict':
      return { ...state, conflictNotice: null };
    case 'server-state':
      if (action.revision === state.serverRevision) return state;
      if (state.editing) {
        return {
          ...state,
          displayValue: action.value,
          serverRevision: action.revision,
        };
      }
      return {
        ...state,
        displayValue: action.value,
        draftValue: action.value,
        editBase: action.value,
        revision: action.revision,
        serverRevision: action.revision,
        conflictNotice: null,
      };
  }
}
