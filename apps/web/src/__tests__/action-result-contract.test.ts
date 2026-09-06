// =============================================================================
// Struktur-Guardrail: neue Form-Actions verwenden den zentralen ActionResult-
// Vertrag und liefern Zod-/Eingabevalidierung mit Feldzuordnung aus.
//
// Der bestehende Altbestand wird pro Datei und Trefferzahl eingefroren. Dadurch
// muss 0.3.0 nicht alle historischen Formulare auf einmal migrieren; jede neue
// lokale Vertragskopie und jeder neue pauschale Validierungsfehler wird aber
// auch in bereits bekannten Dateien sichtbar. Sinkt eine Zahl, wird die
// Baseline bewusst mit abgesenkt, statt den freien Platz später wiederzuverwenden.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CENTRAL_ACTION_RESULT = 'server/actions/types.ts';

/**
 * Historische, noch nicht auf den zentralen Typ migrierte Strukturkopien.
 * Erlaubt werden nur Deklarationen, die `ok` selbst erneut definieren; reine
 * Aliase und payload-spezifische `extends BaseActionResult`-Typen sind korrekt.
 */
const LEGACY_LOCAL_ACTION_RESULT: Readonly<Record<string, number>> = {
  'app/gwg-onboarding/actions.ts': 1,
  'app/staff/(protected)/admin/dsgvo/actions.ts': 1,
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
  'app/staff/(protected)/clients/[id]/gwg/owner-actions.ts': 1,
  'app/staff/(protected)/clients/[id]/handovers/actions.ts': 3,
  'app/staff/(protected)/clients/[id]/notices/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/notices/filings/actions.ts': 3,
  'app/staff/(protected)/clients/[id]/privacy/actions.ts': 1,
  'app/staff/(protected)/clients/[id]/reminders/actions.ts': 10,
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
  'app/staff/(protected)/notifications/actions.ts': 1,
  'app/staff/(protected)/phone-notes/actions.ts': 5,
  'app/staff/(protected)/requests/bulk-actions.ts': 1,
  'app/staff/(protected)/service-providers/actions.ts': 1,
  'app/staff/(protected)/time/actions.ts': 1,
  'app/staff/(protected)/workflows/actions.ts': 3,
};

const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.next', 'coverage']);
const GENERIC_VALIDATION_MESSAGE =
  /Validierungsfehler|Bitte\s+pr(?:ü|ue)fen\s+Sie\s+(?:die\s+)?(?:markierten\s+)?(?:Angaben|Eingaben)/iu;

function walkProductSources(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      result.push(...walkProductSources(path));
    } else if (/\.(?:ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      result.push(path);
    }
  }
  return result;
}

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

function repoRelative(file: string): string {
  return relative(SRC_DIR, file).split(sep).join('/');
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function nonZeroCounts(
  files: readonly string[],
  inspect: (source: ts.SourceFile) => number,
): Record<string, number> {
  return Object.fromEntries(
    files
      .map((file) => [repoRelative(file), inspect(parse(file))] as const)
      .filter((entry) => entry[1] > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function actionSources(files: readonly string[]): string[] {
  return files.filter((file) => readFileSync(file, 'utf8').includes("'use server'"));
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
});
