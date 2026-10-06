// =============================================================================
// Struktur-Guardrail: neue Form-Actions verwenden den zentralen ActionResult-
// Vertrag und liefern Zod-/Eingabevalidierung mit Feldzuordnung aus.
//
// Der bestehende Altbestand wird pro Datei und Trefferzahl eingefroren. Dadurch
// muss 0.3.0 nicht alle historischen Formulare auf einmal migrieren; jede neue
// lokale Vertragskopie und jeder neue pauschale Validierungsfehler wird aber
// auch in bereits bekannten Dateien sichtbar. Sinkt eine Zahl, wird die
// Baseline bewusst mit abgesenkt, statt den freien Platz später wiederzuverwenden.
//
// Rückkanal (Review-Befund F-01): Eine Form-Action ohne Ergebnis kann Fehler nur
// werfen (error.tsx, Eingaben weg) oder verschlucken (der Client meldet Erfolg).
// Deshalb gilt zusätzlich:
//   • keine exportierte Funktion eines 'use server'-Moduls mit deklariertem
//     oder inferiertem Rückgabetyp Promise<void> — Ausnahmen nur mit Begründung;
//   • kein Aufruf von withStaff/withPortalContext/…ActionGuard (inkl. per
//     withStaffModule/withPortalModule gebundener Wrapper), dessen Ergebnis als
//     Ausdrucksanweisung oder per `void` verworfen wird.
// =============================================================================

import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasUseServerDirective, parseSource, walkProductSources } from './use-server-sources';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CENTRAL_ACTION_RESULT = 'server/actions/types.ts';

/**
 * Historische, noch nicht auf den zentralen Typ migrierte Strukturkopien.
 * Erlaubt werden nur Deklarationen, die `ok` selbst erneut definieren; reine
 * Aliase und payload-spezifische `extends BaseActionResult`-Typen sind korrekt.
 */
const LEGACY_LOCAL_ACTION_RESULT: Readonly<Record<string, number>> = {
  'app/gwg-onboarding/actions.ts': 1,
  'app/staff/(protected)/admin/settings/n8n-actions.ts': 1,
  'app/staff/(protected)/clients/[id]/edit/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/tax-schedule/actions.ts': 1,
  'app/staff/(protected)/poa/actions.ts': 1,
};

/**
 * Historische Server-Action-Rueckgaben mit pauschalem Validierungsfehler ohne
 * `fieldErrors`. Die Baseline ist absichtlich dateigenau und wird bei jeder
 * Bereinigung abgesenkt.
 */
const LEGACY_UNMAPPED_VALIDATION_ERRORS: Readonly<Record<string, number>> = {
  'app/gwg-onboarding/actions.ts': 2,
  'app/portal/(protected)/bwa/plan/actions.ts': 3,
  'app/portal/(protected)/forms/[id]/actions.ts': 4,
  'app/portal/(protected)/requests/[id]/actions.ts': 1,
  'app/portal/(protected)/stammdaten/actions.ts': 1,
  'app/staff/(protected)/admin/custom-fields/actions.ts': 3,
  'app/staff/(protected)/admin/document-types/actions.ts': 3,
  'app/staff/(protected)/admin/dsgvo-retention/actions.ts': 2,
  'app/staff/(protected)/admin/dsgvo/actions.ts': 1,
  'app/staff/(protected)/admin/email-templates/actions.ts': 2,
  'app/staff/(protected)/admin/gwg-retention/actions.ts': 2,
  'app/staff/(protected)/admin/invoice-categories/actions.ts': 2,
  'app/staff/(protected)/admin/privacy/actions.ts': 1,
  'app/staff/(protected)/admin/request-templates/actions.ts': 2,
  'app/staff/(protected)/admin/settings/branding-actions.ts': 3,
  'app/staff/(protected)/admin/settings/infra-actions.ts': 3,
  'app/staff/(protected)/admin/settings/mail-actions.ts': 1,
  'app/staff/(protected)/admin/settings/modules-actions.ts': 3,
  'app/staff/(protected)/admin/skills/actions.ts': 3,
  'app/staff/(protected)/admin/users/actions.ts': 5,
  'app/staff/(protected)/clients/[id]/binders/actions.ts': 3,
  'app/staff/(protected)/clients/[id]/bwa/actions.ts': 2,
  'app/staff/(protected)/clients/[id]/bwa/plans/actions.ts': 3,
  'app/staff/(protected)/clients/[id]/change-requests/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/edit/actions.ts': 4,
  'app/staff/(protected)/clients/[id]/elster/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/gwg/actions.ts': 2,
  'app/staff/(protected)/clients/[id]/gwg/invite-actions.ts': 2,
  'app/staff/(protected)/clients/[id]/handovers/actions.ts': 3,
  'app/staff/(protected)/clients/[id]/notices/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/notices/filings/actions.ts': 3,
  'app/staff/(protected)/clients/[id]/privacy/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/reminders/actions.ts': 9,
  'app/staff/(protected)/clients/[id]/workflows/actions.ts': 14,
  'app/staff/(protected)/dashboard/actions.ts': 2,
  'app/staff/(protected)/dashboard/bookmark-actions.ts': 2,
  'app/staff/(protected)/dashboard/note-actions.ts': 1,
  'app/staff/(protected)/dashboard/rss-feed-actions.ts': 3,
  'app/staff/(protected)/dashboard/tax-news-actions.ts': 1,
  'app/staff/(protected)/documents/acknowledge-actions.ts': 1,
  'app/staff/(protected)/documents/actions.ts': 4,
  'app/staff/(protected)/documents/folder-actions.ts': 5,
  'app/staff/(protected)/forms/actions.ts': 4,
  'app/staff/(protected)/invoices/actions.ts': 1,
  'app/staff/(protected)/phone-notes/actions.ts': 5,
  'app/staff/(protected)/requests/bulk-actions.ts': 1,
  'app/staff/(protected)/service-providers/actions.ts': 1,
  'app/staff/(protected)/time/actions.ts': 1,
  'app/staff/(protected)/workflows/actions.ts': 3,
  'server/notifications/actions.ts': 1,
};

/**
 * Server-Actions, die bewusst `Promise<void>` liefern dürfen. Jeder Eintrag
 * braucht eine Begründung; ein umgestellter Eintrag muss hier entfernt werden.
 */
const VOID_ACTION_ALLOWLIST: Readonly<Record<string, string>> = {
  'app/payroll/employee/actions.ts::leaveEmployeeAction':
    'Abmelden aus dem Lohn-Gastzugang: kein Fachfehler möglich, technische Fehler werden ' +
    'geworfen statt verschluckt; das Ergebnis ist die neu gerenderte, abgemeldete Seite.',
  'app/portal/(auth)/login/actions.ts::confirmMagicLinkAction':
    'Jeder Ausgang ist ein Redirect: Erfolg zum Rücksprungziel, Fehler nach ' +
    '/portal/login/verify?status=invalid|rate-limited, wo die Seite den Grund anzeigt.',
  'app/portal/(protected)/profile-actions.ts::switchPortalProfileAction':
    'Navigationsaktion: jeder Ausgang ist ein Redirect (Ziel, Dashboard oder Login); ein ' +
    'nicht auflösbares Zielprofil wird bewusst nicht offengelegt, geschrieben wird dann nichts.',
};

/** Bewusst verworfene Wrapper-Ergebnisse (`datei::Funktion::Wrapper`) mit Begründung. */
const DISCARDED_WRAPPER_RESULT_ALLOWLIST: Readonly<Record<string, string>> = {};

/** Wrapper, deren `{ ok: false }` ein Ergebnis ist und nicht geworfen wird. */
const RESULT_WRAPPERS = new Set([
  'withStaff',
  'withPortalContext',
  'staffActionGuard',
  'staffModuleActionGuard',
  'portalActionGuard',
  'portalModuleActionGuard',
]);
/** Fabriken, deren Rückgabewert selbst ein solcher Wrapper ist. */
const RESULT_WRAPPER_FACTORIES = new Set(['withStaffModule', 'withPortalModule']);

const GENERIC_VALIDATION_MESSAGE =
  /Validierungsfehler|Bitte\s+pr(?:ü|ue)fen\s+Sie\s+(?:die\s+)?(?:markierten\s+)?(?:Angaben|Eingaben)/iu;

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return null;
}

function hasOwnOkMember(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return hasOwnOkMember(type.type);
  if (ts.isIntersectionTypeNode(type) || ts.isUnionTypeNode(type)) {
    return type.types.some(hasOwnOkMember);
  }
  return (
    ts.isTypeLiteralNode(type) &&
    type.members.some(
      (member) => ts.isPropertySignature(member) && propertyName(member.name) === 'ok',
    )
  );
}

export function hasLocalActionResultContract(source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === 'ActionResult' &&
      node.members.some(
        (member) => ts.isPropertySignature(member) && propertyName(member.name) === 'ok',
      )
    ) {
      count += 1;
    } else if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === 'ActionResult' &&
      hasOwnOkMember(node.type)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function isFalseExpression(node: ts.Expression): boolean {
  if (node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return isFalseExpression(node.expression);
  }
  return false;
}

function containsGenericValidationMessage(node: ts.Node): boolean {
  if (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    GENERIC_VALIDATION_MESSAGE.test(node.text)
  ) {
    return true;
  }
  return node.getChildren().some(containsGenericValidationMessage);
}

function objectProperty(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  return node.properties.find(
    (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === name,
  );
}

export function countUnmappedValidationErrors(source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const ok = objectProperty(node, 'ok');
      const error = objectProperty(node, 'error');
      const fieldErrors = objectProperty(node, 'fieldErrors');
      if (
        ok &&
        ts.isPropertyAssignment(ok) &&
        isFalseExpression(ok.initializer) &&
        error &&
        ts.isPropertyAssignment(error) &&
        !fieldErrors &&
        containsGenericValidationMessage(error.initializer)
      ) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function isExportedNode(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Top-Level-Funktionen (Deklarationen und Funktions-Konstanten) nach lokalem Namen. */
function topLevelFunctions(source: ts.SourceFile): Map<string, FunctionNode> {
  const functions = new Map<string, FunctionNode>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          functions.set(declaration.name.text, initializer);
        }
      }
    }
  }
  return functions;
}

/** Exportierte Funktionen: `export function`, `export const x = () =>`, `export { x as y }`. */
function exportedFunctions(source: ts.SourceFile): Array<{ name: string; fn: FunctionNode }> {
  const local = topLevelFunctions(source);
  const exported: Array<{ name: string; fn: FunctionNode }> = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExportedNode(statement)) {
      exported.push({ name: statement.name.text, fn: statement });
    } else if (ts.isVariableStatement(statement) && isExportedNode(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = ts.isIdentifier(declaration.name) ? local.get(declaration.name.text) : undefined;
        if (fn && ts.isIdentifier(declaration.name)) {
          exported.push({ name: declaration.name.text, fn });
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const fn = local.get((element.propertyName ?? element.name).text);
        if (fn) exported.push({ name: element.name.text, fn });
      }
    }
  }
  return exported;
}

function isVoidPromiseType(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return isVoidPromiseType(type.type);
  if (type.kind === ts.SyntaxKind.VoidKeyword) return true;
  if (
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeName.text !== 'Promise' ||
    type.typeArguments?.length !== 1
  ) {
    return false;
  }
  const kind = type.typeArguments[0]!.kind;
  return (
    kind === ts.SyntaxKind.VoidKeyword ||
    kind === ts.SyntaxKind.UndefinedKeyword ||
    kind === ts.SyntaxKind.NeverKeyword
  );
}

/** Gibt der Körper selbst (ohne verschachtelte Funktionen) per `return <ausdruck>` etwas zurück? */
function returnsValue(fn: FunctionNode): boolean {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return !ts.isVoidExpression(fn.body);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/**
 * Exportierte Funktionen mit deklariertem oder inferiertem `Promise<void>`.
 * Inferenz syntaktisch: ohne Annotation gilt eine Funktion ohne
 * `return <ausdruck>` als `Promise<void>` (abgeglichen mit dem Type-Checker).
 */
export function voidExportedActions(source: ts.SourceFile): string[] {
  return exportedFunctions(source)
    .filter(({ fn }) => (fn.type ? isVoidPromiseType(fn.type) : !returnsValue(fn)))
    .map(({ name }) => name);
}

function importedLocalNames(
  source: ts.SourceFile,
  exportedNames: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (exportedNames.has((element.propertyName ?? element.name).text)) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function resultWrapperNames(source: ts.SourceFile): Set<string> {
  const wrappers = new Set([...RESULT_WRAPPERS, ...importedLocalNames(source, RESULT_WRAPPERS)]);
  const factories = new Set([
    ...RESULT_WRAPPER_FACTORIES,
    ...importedLocalNames(source, RESULT_WRAPPER_FACTORIES),
  ]);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        factories.has(initializer.expression.text)
      ) {
        wrappers.add(declaration.name.text);
      }
    }
  }
  return wrappers;
}

function enclosingTopLevelName(node: ts.Node): string {
  let current: ts.Node = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  if (ts.isVariableStatement(current)) {
    const declaration = current.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) return declaration.name.text;
  }
  return '<modul>';
}

/** `Funktion::Wrapper` je Aufruf, dessen Ergebnis verworfen wird (Anweisung oder `void`). */
export function discardedWrapperResults(source: ts.SourceFile): string[] {
  const wrappers = resultWrapperNames(source);
  const discarded: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      wrappers.has(node.expression.text)
    ) {
      let parent = node.parent;
      while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) {
        parent = parent.parent;
      }
      if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) {
        discarded.push(`${enclosingTopLevelName(node)}::${node.expression.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return discarded;
}

function repoRelative(file: string): string {
  return relative(SRC_DIR, file).split(sep).join('/');
}

function nonZeroCounts(
  files: readonly string[],
  inspect: (source: ts.SourceFile) => number,
): Record<string, number> {
  return Object.fromEntries(
    files
      .map((file) => [repoRelative(file), inspect(parseSource(file))] as const)
      .filter((entry) => entry[1] > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Server-Action-Module: dieselbe Direktiven-Erkennung wie server-action-authz.test.ts. */
function actionSources(files: readonly string[]): string[] {
  return files.filter((file) => hasUseServerDirective(parseSource(file)));
}

function expectBaseline(
  actual: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
  label: string,
): void {
  expect(
    actual,
    `${label}\n` +
      'Neue Treffer beheben; bei Reduktionen die dateigenaue Baseline absenken.\n' +
      `Aktueller Stand:\n${JSON.stringify(actual, null, 2)}`,
  ).toEqual(baseline);
}

const productFiles = walkProductSources(SRC_DIR);

describe('ActionResult- und Formularfehler-Guardrail', () => {
  it('erkennt Strukturkopien, aber erlaubt zentrale Aliase und Payload-Erweiterungen', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `
        interface ActionResult { ok: boolean; error?: string }
        type Second = { ok: boolean };
        type ActionResultAlias = Second;
        interface PayloadResult extends BaseActionResult { id?: string }
      `,
      ts.ScriptTarget.Latest,
      true,
    );
    const accepted = ts.createSourceFile(
      'accepted.ts',
      `
        type ActionResult = BaseActionResult;
        interface ActionResultExtension extends BaseActionResult { id?: string }
      `,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(hasLocalActionResultContract(source)).toBe(1);
    expect(hasLocalActionResultContract(accepted)).toBe(0);
  });

  it('erkennt pauschale Validierungsfehler ohne Feldzuordnung', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `
        const legacy = { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
        const mapped = {
          ok: false,
          error: 'Bitte prüfen Sie die markierten Angaben.',
          errorCode: 'VALIDATION_ERROR',
          fieldErrors: { title: ['Pflichtfeld'] },
        };
      `,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(countUnmappedValidationErrors(source)).toBe(1);
  });

  it('friert lokale ActionResult-Strukturkopien repo-weit ein', () => {
    const files = productFiles.filter((file) => repoRelative(file) !== CENTRAL_ACTION_RESULT);
    expectBaseline(
      nonZeroCounts(files, hasLocalActionResultContract),
      LEGACY_LOCAL_ACTION_RESULT,
      'Neue lokale ActionResult-Strukturkopie gefunden.',
    );
  });

  it('friert pauschale Action-Validierungsfehler ohne fieldErrors repo-weit ein', () => {
    expectBaseline(
      nonZeroCounts(actionSources(productFiles), countUnmappedValidationErrors),
      LEGACY_UNMAPPED_VALIDATION_ERRORS,
      'Neuer pauschaler Validierungsfehler ohne Feldzuordnung gefunden.',
    );
  });

  it('erkennt deklarierte und inferierte Promise<void>-Exporte', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `
        export async function declared(formData: FormData): Promise<void> {}
        export async function inferred(formData: FormData) {
          await work(formData);
          if (!formData) return;
        }
        export const arrow = async () => { await work(); };
        export async function never(): Promise<never> { redirect('/x'); }
        export async function nested() {
          const inner = () => { return 1; };
          await inner();
        }
        async function local() {}
        export { local as aliased };
        export async function result(): Promise<ActionResult> { return { ok: true }; }
        export async function inferredResult() { return withStaff(async () => {}); }
        export const expression = async () => withStaff(async () => {});
        async function notExported(): Promise<void> {}
      `,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(voidExportedActions(source)).toEqual([
      'declared',
      'inferred',
      'arrow',
      'never',
      'nested',
      'aliased',
    ]);
  });

  it('erkennt verworfene Ergebnisse der Action-Wrapper', () => {
    const source = ts.createSourceFile(
      'fixture.ts',
      `
        import { withStaff as runStaff, withStaffModule } from '@/server/actions/staff-action';
        const withModuleStaff = withStaffModule('reminders');
        export async function discarded() {
          await runStaff(async () => {});
          void staffActionGuard();
          await (withModuleStaff(async () => {}));
        }
        export async function evaluated() {
          const result = await runStaff(async () => {});
          if (!(await staffActionGuard()).ok) return result;
          return withModuleStaff(async () => {});
        }
      `,
      ts.ScriptTarget.Latest,
      true,
    );

    expect(discardedWrapperResults(source)).toEqual([
      'discarded::runStaff',
      'discarded::staffActionGuard',
      'discarded::withModuleStaff',
    ]);
  });

  it('verlangt einen Rückkanal von jeder Server-Action (kein Promise<void>)', () => {
    const actual = actionSources(productFiles)
      .flatMap((file) =>
        voidExportedActions(parseSource(file)).map((name) => `${repoRelative(file)}::${name}`),
      )
      .sort();
    expect(
      actual,
      'Server-Action ohne Rückkanal: auf (prev, formData) => Promise<ActionResult> umstellen ' +
        'oder mit Begründung in VOID_ACTION_ALLOWLIST aufnehmen; umgestellte Einträge entfernen.',
    ).toEqual(Object.keys(VOID_ACTION_ALLOWLIST).sort());
    for (const reason of Object.values(VOID_ACTION_ALLOWLIST)) expect(reason.trim()).not.toBe('');
  });

  it('verwirft kein Ergebnis von withStaff/withPortalContext/…ActionGuard', () => {
    const actual = productFiles
      .flatMap((file) =>
        discardedWrapperResults(parseSource(file)).map((call) => `${repoRelative(file)}::${call}`),
      )
      .sort();
    expect(
      actual,
      'Wrapper-Ergebnis verworfen: { ok: false } auswerten und zurückgeben ' +
        '(oder mit Begründung in DISCARDED_WRAPPER_RESULT_ALLOWLIST aufnehmen).',
    ).toEqual(Object.keys(DISCARDED_WRAPPER_RESULT_ALLOWLIST).sort());
    for (const reason of Object.values(DISCARDED_WRAPPER_RESULT_ALLOWLIST)) {
      expect(reason.trim()).not.toBe('');
    }
  });
});
