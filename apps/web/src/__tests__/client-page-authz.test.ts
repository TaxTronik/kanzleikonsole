// =============================================================================
// Struktur-Guardrail: JEDE Seite unter /staff/clients/[id]/** prüft den
// Mandantenzugriff selbst, nicht nur das Segment-Layout.
//
// Layouts rendern bei Navigation zwischen Unterseiten nicht erneut, und ein
// gezielt gebauter RSC-Request kann das Layout überspringen; RLS trennt nur
// nach Tenant. Deshalb muss jede page.tsx (und jedes exportierte
// generateMetadata) nach dem Auflösen der Route-Params als ERSTES
// `await requireClientPageAccess(<id aus params>)` rufen — oder den
// Subsumtions-Guard, der ihn seinerseits als Erstes ruft.
//
// Statischer Präsenz- und Reihenfolge-Check über den TS-AST, ohne DB. Die
// Semantik des Guards prüft server/auth/__tests__/client-page-access.test.ts.
// Fachkatalog: ACCESS-CLIENT-MODE-001
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CLIENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'app',
  'staff',
  '(protected)',
  'clients',
  '[id]',
);
const SUBSUMTION_GUARD = join(CLIENT_DIR, 'subsumtion', '_guard.ts');
const ACCESS_MODULE = '@/server/auth/client-page-access';

type RouteFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function walkPages(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walkPages(path));
    else if (entry === 'page.tsx') files.push(path);
  }
  return files;
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function label(file: string): string {
  return relative(CLIENT_DIR, file).replaceAll('\\', '/');
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isFunctionValue(
  node: ts.Node | undefined,
): node is ts.FunctionExpression | ts.ArrowFunction {
  return !!node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node));
}

/** Lokale Namen, unter denen die Datei den kanonischen Guard importiert. */
function trustedGuards(file: string, source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue;
    if (!ts.isNamedImports(clause.namedBindings)) continue;
    const specifier = statement.moduleSpecifier.text;
    const trusted =
      specifier === ACCESS_MODULE
        ? 'requireClientPageAccess'
        : specifier.startsWith('.') &&
            resolve(dirname(file), `${specifier}.ts`) === SUBSUMTION_GUARD
          ? 'guardSubsumtionPage'
          : null;
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === trusted) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** Default-Export und generateMetadata: beide laufen mit den Route-Params. */
function routeFunctions(source: ts.SourceFile): Array<[string, RouteFunction | undefined]> {
  const declared = new Map<string, RouteFunction>();
  const found: Array<[string, RouteFunction | undefined]> = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      if (statement.name) declared.set(statement.name.text, statement);
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) found.push(['default', statement]);
      else if (statement.name?.text === 'generateMetadata') {
        found.push(['generateMetadata', statement]);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !isFunctionValue(declaration.initializer))
          continue;
        declared.set(declaration.name.text, declaration.initializer);
        if (
          hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
          declaration.name.text === 'generateMetadata'
        ) {
          found.push(['generateMetadata', declaration.initializer]);
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const target = statement.expression;
      found.push([
        'default',
        isFunctionValue(target)
          ? target
          : ts.isIdentifier(target)
            ? declared.get(target.text)
            : undefined,
      ]);
    }
  }
  return found;
}

function isPromiseAll(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Promise' &&
    node.expression.name.text === 'all' &&
    node.arguments.length === 1 &&
    ts.isArrayLiteralExpression(node.arguments[0]!)
  );
}

/** Lokale Namen von `params`/`searchParams` aus `({ params, searchParams })`. */
function routeParamNames(fn: RouteFunction): { params: string; resolvable: Set<string> } {
  let params = 'params';
  const resolvable = new Set(['params', 'searchParams']);
  const first = fn.parameters[0];
  if (first && ts.isObjectBindingPattern(first.name)) {
    resolvable.clear();
    for (const element of first.name.elements) {
      const property = element.propertyName ?? element.name;
      if (!ts.isIdentifier(property) || !ts.isIdentifier(element.name)) continue;
      if (property.text === 'params') params = element.name.text;
      if (property.text === 'params' || property.text === 'searchParams') {
        resolvable.add(element.name.text);
      }
    }
  }
  return { params, resolvable };
}

function addIdBinding(name: ts.BindingName | undefined, ids: Set<string>) {
  if (!name || !ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    const property = element.propertyName ?? element.name;
    if (ts.isIdentifier(property) && property.text === 'id' && ts.isIdentifier(element.name)) {
      ids.add(element.name.text);
    }
  }
}

/** Namen, an die `id` aus `await params` (auch via Promise.all) gebunden wird. */
function routeIdNames(fn: RouteFunction, params: string): Set<string> {
  const ids = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer)
    ) {
      const awaited = node.initializer.expression;
      if (ts.isIdentifier(awaited) && awaited.text === params) addIdBinding(node.name, ids);
      if (isPromiseAll(awaited) && ts.isArrayBindingPattern(node.name)) {
        const items = (awaited.arguments[0] as ts.ArrayLiteralExpression).elements;
        const bindings = node.name.elements;
        items.forEach((item, index) => {
          const binding = bindings[index];
          if (
            ts.isIdentifier(item) &&
            item.text === params &&
            binding &&
            ts.isBindingElement(binding)
          ) {
            addIdBinding(binding.name, ids);
          }
        });
      }
    }
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return ids;
}

/** Aufrufe und awaits in Quelltext-Reihenfolge; verschachtelte Funktionen laufen später. */
function executedNodes(body: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return nodes.sort((left, right) => left.getStart() - right.getStart());
}

function isTopLevelAwait(call: ts.CallExpression, body: ts.Node): boolean {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return false;
  const holder = awaited.parent;
  if (ts.isExpressionStatement(holder)) return holder.parent === body;
  return (
    ts.isVariableDeclaration(holder) &&
    holder.initializer === awaited &&
    ts.isVariableDeclarationList(holder.parent) &&
    ts.isVariableStatement(holder.parent.parent) &&
    holder.parent.parent.parent === body
  );
}

/**
 * Der Guard muss der erste ausgeführte Aufruf sein, mit `await` auf oberster
 * Ebene und mit der Mandanten-ID aus der URL. Davor ist nur das Auflösen der
 * Route-Params erlaubt.
 */
function guardFirstViolation(
  fn: RouteFunction,
  guards: ReadonlySet<string>,
  clientIds: ReadonlySet<string>,
  resolvable: ReadonlySet<string>,
): string | null {
  if (!fn.body || !ts.isBlock(fn.body)) return 'kein Funktionsrumpf';
  const isResolution = (node: ts.Node): boolean => {
    const target = ts.isAwaitExpression(node) ? node.expression : node;
    if (ts.isIdentifier(target)) return ts.isAwaitExpression(node) && resolvable.has(target.text);
    return (
      isPromiseAll(target) &&
      (target.arguments[0] as ts.ArrayLiteralExpression).elements.every(
        (item) => ts.isIdentifier(item) && resolvable.has(item.text),
      )
    );
  };
  const nodes = executedNodes(fn.body);
  const guard = nodes.find(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      guards.has(node.expression.text),
  );
  if (!guard) return 'ruft weder requireClientPageAccess noch guardSubsumtionPage';
  const before = nodes.find(
    (node) => node.getStart() < guard.getStart() && node !== guard.parent && !isResolution(node),
  );
  if (before) return `lädt vor dem Zugriffs-Guard: ${before.getText().split('\n')[0]}`;
  if (!isTopLevelAwait(guard, fn.body)) return 'Guard nicht unbedingt auf oberster Ebene awaited';
  const [clientId] = guard.arguments;
  if (!clientId || !ts.isIdentifier(clientId) || !clientIds.has(clientId.text)) {
    return `Guard nicht mit der Mandanten-ID aus params gerufen: ${guard.getText()}`;
  }
  return null;
}

function routeFileViolations(file: string, text: string): string[] {
  const source = parse(file, text);
  const guards = trustedGuards(file, source);
  const functions = routeFunctions(source);
  if (!functions.some(([name]) => name === 'default'))
    return [`${label(file)}: kein Default-Export`];
  return functions.flatMap(([name, fn]) => {
    if (!fn) return [`${label(file)}#${name}: Export nicht statisch auflösbar`];
    const { params, resolvable } = routeParamNames(fn);
    const violation = guardFirstViolation(fn, guards, routeIdNames(fn, params), resolvable);
    return violation ? [`${label(file)}#${name}: ${violation}`] : [];
  });
}

function subsumtionGuardViolations(text: string): string[] {
  const source = parse(SUBSUMTION_GUARD, text);
  const fn = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'guardSubsumtionPage' &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword),
  );
  const clientId = fn?.parameters[0]?.name;
  if (!fn || !clientId || !ts.isIdentifier(clientId)) return ['guardSubsumtionPage fehlt'];
  const violation = guardFirstViolation(
    fn,
    trustedGuards(SUBSUMTION_GUARD, source),
    new Set([clientId.text]),
    new Set(),
  );
  return violation ? [`subsumtion/_guard.ts#guardSubsumtionPage: ${violation}`] : [];
}

describe('Mandanten-Seiten prüfen den Zugriff selbst', () => {
  const pages = walkPages(CLIENT_DIR);

  it('findet die Seiten des Segments', () => {
    expect(pages.length).toBeGreaterThanOrEqual(25);
  });

  it('ruft in jeder page.tsx und jedem generateMetadata zuerst den Mandanten-Guard', () => {
    const violations = pages.flatMap((file) =>
      routeFileViolations(file, readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('nutzt im Segment-Layout denselben request-gecachten Guard', () => {
    const layout = join(CLIENT_DIR, 'layout.tsx');
    expect(routeFileViolations(layout, readFileSync(layout, 'utf8'))).toEqual([]);
  });

  it('ruft im Subsumtions-Guard requireClientPageAccess vor allem anderen', () => {
    expect(subsumtionGuardViolations(readFileSync(SUBSUMTION_GUARD, 'utf8'))).toEqual([]);
  });
});

describe('Prüflogik des Guardrails', () => {
  const file = join(CLIENT_DIR, 'beispiel', 'page.tsx');
  const imports = `import { requireClientPageAccess } from '${ACCESS_MODULE}';\n`;
  const page = (body: string, head = imports) =>
    `${head}export default async function Page({ params }: { params: Promise<{ id: string }> }) {\n${body}\n}\n`;

  it('akzeptiert das Standardmuster', () => {
    const source = page(
      'const { id: clientId } = await params;\nconst session = await requireClientPageAccess(clientId);\nreturn load(session, clientId);',
    );
    expect(routeFileViolations(file, source)).toEqual([]);
  });

  it('meldet eine Seite ohne Guard', () => {
    const source = page('const { id } = await params;\nreturn load(id);');
    expect(routeFileViolations(file, source)).toEqual([
      'beispiel/page.tsx#default: ruft weder requireClientPageAccess noch guardSubsumtionPage',
    ]);
  });

  it('meldet Datenzugriffe vor dem Guard', () => {
    const source = page(
      'const { id } = await params;\nconst data = await load(id);\nawait requireClientPageAccess(id);\nreturn data;',
    );
    expect(routeFileViolations(file, source)).toEqual([
      'beispiel/page.tsx#default: lädt vor dem Zugriffs-Guard: await load(id)',
    ]);
  });

  it('meldet einen Guard mit fremder oder bedingter Mandanten-ID', () => {
    expect(
      routeFileViolations(file, page("await params;\nawait requireClientPageAccess('fest');")),
    ).toEqual([
      "beispiel/page.tsx#default: Guard nicht mit der Mandanten-ID aus params gerufen: requireClientPageAccess('fest')",
    ]);
    expect(
      routeFileViolations(
        file,
        page('const { id } = await params;\nif (id) await requireClientPageAccess(id);'),
      ),
    ).toEqual(['beispiel/page.tsx#default: Guard nicht unbedingt auf oberster Ebene awaited']);
  });

  it('akzeptiert keinen gleichnamigen, nicht kanonisch importierten Guard', () => {
    const source = page(
      'const { id } = await params;\nawait requireClientPageAccess(id);',
      "import { requireClientPageAccess } from './eigener-guard';\n",
    );
    expect(routeFileViolations(file, source)).toEqual([
      'beispiel/page.tsx#default: ruft weder requireClientPageAccess noch guardSubsumtionPage',
    ]);
  });

  it('prüft auch generateMetadata', () => {
    const source = `${page('const { id } = await params;\nawait requireClientPageAccess(id);')}export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {\nconst { id } = await params;\nreturn { title: await loadName(id) };\n}\n`;
    expect(routeFileViolations(file, source)).toEqual([
      'beispiel/page.tsx#generateMetadata: ruft weder requireClientPageAccess noch guardSubsumtionPage',
    ]);
  });
});
