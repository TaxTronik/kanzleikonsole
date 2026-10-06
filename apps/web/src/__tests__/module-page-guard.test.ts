// =============================================================================
// Struktur-Guardrail: JEDE Seite unter einem Pfad der Modul-Registry prüft ihr
// Modul selbst (requireModulePage), nicht nur das Layout-Gate.
//
// Layouts rendern bei Navigation zwischen Unterseiten nicht erneut, und ein
// gezielt gebauter RSC-Request kann das Layout überspringen. Die Seite muss
// deshalb in ihrer Default-Export-Funktion `requireModulePage('<surface>',
// '<bereich>')` mit genau dem Registry-Bereich ihres Pfads aufrufen — oder einen
// der geprüften Wrapper (Mandatsorganisation, Subsumtion), der das tut.
//
// Statischer Check über den TS-AST, ohne DB. Die Semantik des Helpers prüft
// server/settings/__tests__/module-page.test.ts.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { moduleAreaForPath, type ModuleSurface } from '@/lib/module-registry';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const SURFACES: ModuleSurface[] = ['staff', 'portal'];
const EXPANSION_COMMON = join(APP_DIR, 'staff', '(protected)', 'mandate-expansion', 'common.tsx');
const SUBSUMTION_GUARD = join(
  APP_DIR,
  'staff',
  '(protected)',
  'clients',
  '[id]',
  'subsumtion',
  '_guard.ts',
);

function walkPages(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walkPages(path));
    else if (entry === 'page.tsx') files.push(path);
  }
  return files;
}

function routeOf(file: string): string {
  const segments = relative(APP_DIR, dirname(file))
    .split(/[\\/]/)
    .filter((segment) => !/^\(.*\)$/.test(segment));
  return `/${segments.join('/')}`;
}

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function isExportDefault(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** Aufrufe im Rumpf der Default-Export-Seite (ohne verschachtelte Funktionen). */
function pageCalls(source: ts.SourceFile): ts.CallExpression[] {
  const page = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && isExportDefault(statement),
  );
  if (!page?.body) return [];
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  page.body.statements.forEach(visit);
  return calls;
}

function callName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function literalArgs(call: ts.CallExpression): string[] {
  return call.arguments.map((arg) => (ts.isStringLiteral(arg) ? arg.text : '<expr>'));
}

/** Registry-Bereiche, die eine Seite prüft (direkt oder über geprüfte Wrapper). */
function checkedAreas(file: string, surface: ModuleSurface): string[] {
  const areas: string[] = [];
  for (const call of pageCalls(parse(file))) {
    const name = callName(call);
    const args = literalArgs(call);
    if (name === 'requireModulePage' && args[0] === surface) areas.push(args[1]!);
    if (name === 'expansionPage') areas.push(args[0]!);
    if (name === 'guardSubsumtionPage') areas.push('risk');
  }
  return areas;
}

const PAGES = SURFACES.flatMap((surface) =>
  walkPages(join(APP_DIR, surface, '(protected)')).map((file) => ({
    surface,
    file,
    route: routeOf(file),
    area: moduleAreaForPath(surface, routeOf(file)),
  })),
);

describe('Modulseiten prüfen ihr Modul selbst (requireModulePage)', () => {
  it('findet die Modulseiten der Registry', () => {
    expect(PAGES.filter((page) => page.area).length).toBeGreaterThanOrEqual(70);
  });

  it.each(PAGES.filter((page) => page.area).map((page) => [page.route, page] as const))(
    '%s',
    (_route, page) => {
      expect(checkedAreas(page.file, page.surface)).toEqual([page.area]);
    },
  );

  it('Seiten ohne Registry-Pfad rufen requireModulePage nicht mit fremdem Bereich', () => {
    for (const page of PAGES.filter((candidate) => !candidate.area)) {
      expect(checkedAreas(page.file, page.surface), page.route).toEqual([]);
    }
  });

  it('die Wrapper reichen den Bereich an requireModulePage durch', () => {
    const expansion = readFileSync(EXPANSION_COMMON, 'utf8');
    expect(expansion).toContain("await requireModulePage('staff', area)");
    const subsumtion = readFileSync(SUBSUMTION_GUARD, 'utf8');
    expect(subsumtion).toContain("await requireModulePage('staff', 'risk')");
  });
});
