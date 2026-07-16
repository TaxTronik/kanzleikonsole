import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface IdentityReviewEditableFields {
  type: 'PERSONALAUSWEIS' | 'REISEPASS';
  number: string;
  issuedBy: string;
  issueDate: string;
  expiryDate: string;
}

interface IdentityReviewLocalState {
  revision: string;
  fields: IdentityReviewEditableFields;
  selectedSubjectKey: string;
  ownerName: string;
  confirmedRevision: string | null;
}

interface IdentityReviewSavedState extends IdentityReviewEditableFields {
  subjectKey: string;
  ownerName: string;
}

type ApplySave = (saved: IdentityReviewSavedState, revision: string) => IdentityReviewLocalState;
type ReconcileServerState = (
  current: IdentityReviewLocalState,
  incoming: IdentityReviewLocalState,
  supersededRevisions: ReadonlySet<string>,
) => IdentityReviewLocalState;

function loadStateFunctions(): {
  applyIdentityReviewSave: ApplySave;
  reconcileIdentityReviewServerState: ReconcileServerState;
} {
  const sourcePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'identity-document-review.tsx',
  );
  const source = readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set(['applyIdentityReviewSave', 'reconcileIdentityReviewServerState']);
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      names.has(statement.name.text),
  );
  expect(declarations.map((declaration) => declaration.name!.text).sort()).toEqual(
    [...names].sort(),
  );

  const printer = ts.createPrinter();
  const functions = declarations
    .map((declaration) => printer.printNode(ts.EmitHint.Unspecified, declaration, sourceFile))
    .join('\n')
    .replace(/^export\s+/gm, '');
  const javascript = ts.transpileModule(functions, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const factory = new Function(
    `${javascript}\nreturn { applyIdentityReviewSave, reconcileIdentityReviewServerState };`,
  ) as () => {
    applyIdentityReviewSave: ApplySave;
    reconcileIdentityReviewServerState: ReconcileServerState;
  };
  return factory();
}

const { applyIdentityReviewSave, reconcileIdentityReviewServerState } = loadStateFunctions();

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
});
