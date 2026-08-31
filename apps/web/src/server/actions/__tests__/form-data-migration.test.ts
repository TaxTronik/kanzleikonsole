import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const APP_ROOT = fileURLToPath(new URL('../../../app', import.meta.url));

interface DirectFormDataParse {
  id: string;
  exact: boolean;
}

function actionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return actionFiles(path);
    // Suffix-Match wie im Authz-Guard: seit der Aufteilung der grossen
    // Action-Dateien heissen sie auch owner-actions.ts, norm-actions.ts, … —
    // ein Exakt-Match liesse deren formData-Parses aus der Inventur fallen.
    return entry.name.endsWith('actions.ts') ? [path] : [];
  });
}

function isExactFormDataObject(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): boolean {
  return object.properties.every((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return false;
    const value = property.initializer;
    if (
      !ts.isCallExpression(value) ||
      !ts.isPropertyAccessExpression(value.expression) ||
      value.expression.getText(sourceFile) !== 'formData.get' ||
      value.arguments.length !== 1
    ) {
      return false;
    }
    const argument = value.arguments[0];
    return (
      argument !== undefined && ts.isStringLiteral(argument) && argument.text === property.name.text
    );
  });
}

function inventory(): { direct: DirectFormDataParse[]; shared: number } {
  const direct: DirectFormDataParse[] = [];
  let shared = 0;

  for (const file of actionFiles(APP_ROOT)) {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const fileId = relative(APP_ROOT, file).replaceAll('\\', '/');

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'parseFormData') shared++;

        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'safeParse' &&
          node.arguments[0] &&
          ts.isObjectLiteralExpression(node.arguments[0]) &&
          node.arguments[0].getText(sourceFile).includes('formData.get(')
        ) {
          const schema = node.expression.expression.getText(sourceFile).replaceAll(/\s+/g, ' ');
          direct.push({
            id: `${fileId}::${schema}`,
            exact: isExactFormDataObject(node.arguments[0], sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { direct, shared };
}

describe('parseFormData-Migrationsrest', () => {
  it('lässt nur bewusst klassifizierte formal direkte Sonderfälle stehen', () => {
    const { direct } = inventory();
    const exact = direct
      .filter((call) => call.exact)
      .map((call) => call.id)
      .sort();

    expect(exact).toEqual(
      [
        // Die vier *-actions.ts-Eintraege sind KEINE neuen Faelle: sie lagen
        // schon immer so vor, fielen aber aus dem frueheren Exakt-Match
        // ('actions.ts') der Inventur. Mit dem Suffix-Match sind sie jetzt
        // sichtbar und hier bewusst klassifiziert.
        'portal/(protected)/profile-actions.ts::SwitchProfileSchema',
        'staff/(protected)/admin/settings/branding-actions.ts::LetterheadSchema',
        'staff/(protected)/admin/settings/mail-actions.ts::MailDispatchSchema',
        'staff/(protected)/admin/settings/modules-actions.ts::AccessPolicySchema',
        'staff/(protected)/clients/[id]/edit/actions.ts::GwgSchema',
        'staff/(protected)/clients/onboarding/[id]/actions.ts::GwgSchema',
      ].sort(),
    );
  });

  it('misst den verbleibenden transformierten Rest und die gemeinsame Nutzung', () => {
    const { direct, shared } = inventory();

    // Der Bescheid-Parser transformiert inzwischen zusaetzliche Abrufdaten und
    // ist deshalb korrekt im transformierten Rest statt bei den exakten
    // Feld-zu-Feld-Parses. Die Gesamtzahl der direkten Parses bleibt gleich;
    // Der interne Anforderungskommentar und die neue tägliche
    // Fristenabschlusskontrolle sowie die fünf neuen GwG-Personen- und
    // Nachweisaktionen nutzen dagegen den gemeinsamen, strikt schema-basierten
    // parseFormData-Helfer. GWG-SELF-ONBOARDING-001: Auch der Start der
    // kanzleiinternen Erfassung verwendet diesen gemeinsamen Parser.
    expect(direct).toHaveLength(55);
    expect(direct.filter((call) => !call.exact)).toHaveLength(49);
    expect(shared).toBe(39);
  });
});
