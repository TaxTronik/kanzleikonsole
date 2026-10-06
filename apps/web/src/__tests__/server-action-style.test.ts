// =============================================================================
// Struktur-Guardrail (Review-Befund K-02): ein Stil für Auth, Transaktion und
// Fehler in Server-Actions.
//
// Jede exportierte Funktion eines 'use server'-Moduls wird klassifiziert:
//   • wrapper     — läuft über withStaff/withPortalContext (auch gebunden per
//                   withStaffModule/withPortalModule) oder den mehrphasigen
//                   Baustein staffAction/portalAction; direkt, über einen
//                   Helfer derselben Datei oder einen relativ importierten
//                   Helfer. Nur Importe aus den kanonischen Modulen zählen.
//   • delegating  — ruft eine andere exportierte Action auf.
//   • public      — bewusster Auth-Eintrittspunkt ohne Session (Login, Token).
//   • handwritten — alles andere: eigenes Gate (staffActionGuard,
//                   portalActionGuard, portalAuth, eigene Guard-Familien) mit
//                   handgeschriebener Transaktion, try/catch und Fehler-Mapping.
//
// Zusätzlich: kein redirect()/notFound() innerhalb eines Baustein-Callbacks —
// NEXT_REDIRECT liefe dort ins Fehler-Mapping und endete als „Unerwarteter
// Fehler“ (bei withStaff samt Rollback). Navigation nach Erfolg prüft das
// Ergebnis und leitet außerhalb weiter.
//
// Der handgeschriebene Rest ist pro Datei mit Anzahl und Begründung in
// server-action-style.baseline.ts eingefroren. Der Test schlägt fehl, wenn eine
// Datei mehr handgeschriebene Actions enthält als eingefroren (neue Actions:
// withStaff/withPortalContext oder staffAction/portalAction), und ebenso, wenn
// eine Datei besser geworden ist — dann wird die Baseline abgesenkt, statt den
// frei gewordenen Platz später wiederzuverwenden.
//
// Review-Befund R-12 (gleiche Sperrklinke, eigene Baselines):
//   • Audit-Akteur von Hand: evidenceService.record mit tenantId/actorType/
//     actorId im Ereignis. Neue Audits laufen über audit(tx, g, event)
//     (server/actions/audit.ts), das das Tripel aus dem Gate-Kontext nimmt.
//   • FormData Feld für Feld: formData.get/getAll auf einem FormData-Parameter.
//     Neue Form-Actions lesen über parseFormData(schema, formData) (Feldfehler).
// =============================================================================

import { dirname, join, relative, sep } from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseSource, serverActionSourceFiles } from './use-server-sources';
import {
  FORM_DATA_READ_BASELINE,
  HAND_FILLED_AUDIT_BASELINE,
  HANDWRITTEN_ACTION_BASELINE,
  PUBLIC_ACTION_ENTRY_POINTS,
} from './server-action-style.baseline';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Kanonische Bausteine: direkt aufrufbare Wrapper und Fabriken gebundener Wrapper. */
const CANONICAL_ACTION_MODULES = new Map<
  string,
  { wrappers: ReadonlySet<string>; factories: ReadonlySet<string> }
>([
  [
    '@/server/actions/staff-action',
    { wrappers: new Set(['withStaff', 'staffAction']), factories: new Set(['withStaffModule']) },
  ],
  [
    '@/server/actions/portal-action',
    {
      wrappers: new Set(['withPortalContext', 'portalAction']),
      factories: new Set(['withPortalModule']),
    },
  ],
]);

export type ActionStyle = 'wrapper' | 'delegating' | 'public' | 'handwritten';

interface TopLevelFunction {
  name: string;
  node: ts.Node;
}

function isExported(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** Top-Level-Funktionen (Deklarationen, Funktions-Konstanten) und ihre Export-Namen. */
function topLevelFunctions(source: ts.SourceFile): {
  functions: Map<string, TopLevelFunction>;
  exported: Map<string, string>;
} {
  const functions = new Map<string, TopLevelFunction>();
  const exported = new Map<string, string>(); // Exportname → lokaler Name
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.set(statement.name.text, { name: statement.name.text, node: statement });
      if (isExported(statement)) exported.set(statement.name.text, statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          functions.set(declaration.name.text, { name: declaration.name.text, node: initializer });
          if (isExported(statement)) exported.set(declaration.name.text, declaration.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exported.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }
  return { functions, exported };
}

/** Bezeichner, die ein Knoten referenziert (ohne Eigenschaftsnamen wie `obj.withStaff`). */
function referencedNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (
      ts.isIdentifier(child) &&
      !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)
    ) {
      names.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/** Importierte Wrapper und Fabriken aus den kanonischen Modulen (Aliase eingeschlossen). */
function canonicalImports(source: ts.SourceFile): {
  wrappers: Set<string>;
  factories: Set<string>;
} {
  const wrappers = new Set<string>();
  const factories = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const canonical = CANONICAL_ACTION_MODULES.get(statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (!canonical || statement.importClause?.isTypeOnly || !bindings) continue;
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (canonical.wrappers.has(imported)) wrappers.add(element.name.text);
      if (canonical.factories.has(imported)) factories.add(element.name.text);
    }
  }
  return { wrappers, factories };
}

/** Wrapper-Bindungen einer Datei: kanonische Importe + per Fabrik gebundene Wrapper. */
function trustedWrapperBindings(source: ts.SourceFile): Set<string> {
  const { wrappers, factories } = canonicalImports(source);
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

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* nicht vorhanden */
    }
  }
  return null;
}

/**
 * Lokale Namen, die (transitiv) über einen kanonischen Wrapper laufen: Wrapper-
 * Bindungen, Helfer derselben Datei und relativ importierte Helfer.
 */
export function wrapperCarryingNames(
  source: ts.SourceFile,
  resolveImport: (specifier: string) => ts.SourceFile | null = () => null,
  seen: Set<string> = new Set(),
): Set<string> {
  seen.add(source.fileName);
  const carrying = trustedWrapperBindings(source);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const target = resolveImport(statement.moduleSpecifier.text);
    if (!target || seen.has(target.fileName)) continue;
    const targetCarrying = wrapperCarryingNames(target, () => null, seen);
    for (const element of bindings.elements) {
      if (targetCarrying.has((element.propertyName ?? element.name).text)) {
        carrying.add(element.name.text);
      }
    }
  }
  const { functions } = topLevelFunctions(source);
  const references = new Map([...functions].map(([name, fn]) => [name, referencedNames(fn.node)]));
  for (let before = -1; before !== carrying.size; ) {
    before = carrying.size;
    for (const [name, names] of references) {
      if (!carrying.has(name) && [...carrying].some((wrapper) => names.has(wrapper))) {
        carrying.add(name);
      }
    }
  }
  return carrying;
}

/** Stil je exportierter Action einer Datei. */
export function classifyActions(
  source: ts.SourceFile,
  options: {
    resolveImport?: (specifier: string) => ts.SourceFile | null;
    knownActions?: ReadonlySet<string>;
    isPublic?: (exportName: string) => boolean;
  } = {},
): Map<string, ActionStyle> {
  const { functions, exported } = topLevelFunctions(source);
  const carrying = wrapperCarryingNames(source, options.resolveImport);
  const styles = new Map<string, ActionStyle>();
  for (const [exportName, localName] of exported) {
    const fn = functions.get(localName);
    if (!fn) continue;
    const names = referencedNames(fn.node);
    names.delete(localName);
    if ([...names].some((name) => carrying.has(name))) styles.set(exportName, 'wrapper');
    else if ([...names].some((name) => name !== exportName && options.knownActions?.has(name)))
      styles.set(exportName, 'delegating');
    else if (options.isPublic?.(exportName)) styles.set(exportName, 'public');
    else styles.set(exportName, 'handwritten');
  }
  return styles;
}

/** Navigation aus next/navigation, die per Ausnahme (NEXT_REDIRECT …) arbeitet. */
const NAVIGATION_EXPORTS = new Set(['redirect', 'permanentRedirect', 'notFound', 'forbidden']);

function navigationBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'next/navigation'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (NAVIGATION_EXPORTS.has((element.propertyName ?? element.name).text)) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** `Wrapper::navigation` je Navigation, die lexikalisch in einem Baustein-Argument steht. */
export function navigationInsideWrappers(source: ts.SourceFile): string[] {
  const wrappers = trustedWrapperBindings(source);
  const navigation = navigationBindings(source);
  const hits: string[] = [];
  const visit = (node: ts.Node, wrapper: string | null): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (wrapper && navigation.has(callee)) hits.push(`${wrapper}::${callee}`);
      if (wrappers.has(callee)) {
        for (const argument of node.arguments) visit(argument, callee);
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, wrapper));
  };
  visit(source, null);
  return hits;
}

const srcRelative = (file: string) => relative(SRC_DIR, file).split(sep).join('/');
const actionFiles = serverActionSourceFiles(SRC_DIR);
const parsed = new Map(actionFiles.map((file) => [file, parseSource(file)]));
const knownActions = new Set(
  [...parsed.values()].flatMap((source) => [...topLevelFunctions(source).exported.keys()]),
);

function isPublicEntryPoint(file: string, exportName: string): boolean {
  return (
    PUBLIC_ACTION_ENTRY_POINTS[file] !== undefined ||
    PUBLIC_ACTION_ENTRY_POINTS[`${file}::${exportName}`] !== undefined
  );
}

function classifyFile(file: string): Map<string, ActionStyle> {
  const rel = srcRelative(file);
  return classifyActions(parsed.get(file)!, {
    resolveImport: (specifier) => {
      const target = resolveRelative(file, specifier);
      return target ? parseSource(target) : null;
    },
    knownActions,
    isPublic: (exportName) => isPublicEntryPoint(rel, exportName),
  });
}

const classified = new Map(actionFiles.map((file) => [srcRelative(file), classifyFile(file)]));

function handwrittenPerFile(): Record<string, number> {
  return Object.fromEntries(
    [...classified]
      .map(([file, styles]) => {
        const count = [...styles.values()].filter((style) => style === 'handwritten').length;
        return [file, count] as const;
      })
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * R-12: evidenceService.record-Aufrufe, deren Ereignis den Akteur von Hand
 * trägt (tenantId/actorType/actorId) oder kein Objektliteral ist.
 */
export function handFilledAuditCalls(source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'record' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'evidenceService'
    ) {
      const event = node.arguments[1];
      const actorFields = new Set(['tenantId', 'actorType', 'actorId']);
      if (
        !event ||
        !ts.isObjectLiteralExpression(event) ||
        event.properties.some(
          (property) =>
            !property.name ||
            (ts.isIdentifier(property.name) && actorFields.has(property.name.text)),
        )
      ) {
        count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

/** R-12: formData.get/getAll auf einem als FormData deklarierten Parameter. */
export function formDataReads(source: ts.SourceFile): number {
  const formDataParams = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      node.type &&
      /\bFormData\b/.test(node.type.getText(source))
    ) {
      formDataParams.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'get' || node.expression.name.text === 'getAll') &&
      ts.isIdentifier(node.expression.expression) &&
      formDataParams.has(node.expression.expression.text)
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function countPerFile(counter: (source: ts.SourceFile) => number): Record<string, number> {
  return Object.fromEntries(
    actionFiles
      .map((file) => [srcRelative(file), counter(parsed.get(file)!)] as const)
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

const parseFixture = (text: string, fileName = 'fixture.ts') =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);

describe('Server-Action-Stil (K-02)', () => {
  it('erkennt Wrapper nur aus den kanonischen Modulen, auch gebunden und über Helfer', () => {
    const source = parseFixture(`
      'use server';
      import { withStaff as runStaff, staffAction, staffActionGuard, withStaffModule } from '@/server/actions/staff-action';
      import { portalAction } from '@/server/actions/portal-action';
      import { withPortalContext } from './fake';
      const withReminders = withStaffModule('reminders');
      async function core(formData) { return staffAction({ run: async () => {} }); }
      async function guard() { return staffActionGuard(); }
      export async function aliased() { return runStaff(async () => {}); }
      export async function bound() { return withReminders(async () => {}); }
      export async function viaHelper(fd) { const r = await core(fd); return r; }
      export async function portal() { return portalAction({ run: async () => {} }); }
      export async function fake() { return withPortalContext(async () => {}); }
      export async function manual() { const g = await guard(); if (!g.ok) return g; return { ok: true }; }
      export async function delegates() { return manualAction(); }
      export async function login() { return { ok: true }; }
      async function local() { return runStaff(async () => {}); }
      export { local as exportedAlias };
    `);

    const styles = classifyActions(source, {
      knownActions: new Set(['manualAction']),
      isPublic: (name) => name === 'login',
    });

    expect(Object.fromEntries(styles)).toEqual({
      aliased: 'wrapper',
      bound: 'wrapper',
      viaHelper: 'wrapper',
      portal: 'wrapper',
      fake: 'handwritten',
      manual: 'handwritten',
      delegates: 'delegating',
      login: 'public',
      exportedAlias: 'wrapper',
    });
  });

  it('löst Wrapper über relativ importierte Helfer auf, eine Eigenschaft gleichen Namens zählt nicht', () => {
    const helper = parseFixture(
      `
      import { withStaff } from '@/server/actions/staff-action';
      export async function runShared() { return withStaff(async () => {}); }
      export async function plain() { return 1; }
    `,
      '_helpers.ts',
    );
    const source = parseFixture(`
      'use server';
      import { runShared, plain } from './_helpers';
      export async function shared() { return runShared(); }
      export async function notShared() { return plain(); }
      export async function property(g) { return g.withStaff(); }
    `);

    const styles = classifyActions(source, {
      resolveImport: (specifier) => (specifier === './_helpers' ? helper : null),
    });

    expect(Object.fromEntries(styles)).toEqual({
      shared: 'wrapper',
      notShared: 'handwritten',
      property: 'handwritten',
    });
  });

  it('erkennt Navigation innerhalb eines Baustein-Callbacks', () => {
    const source = parseFixture(`
      'use server';
      import { redirect as go, notFound } from 'next/navigation';
      import { staffAction, withStaff } from '@/server/actions/staff-action';
      export async function inside() {
        return staffAction({ run: async () => { go('/x'); } });
      }
      export async function insideTx() {
        return withStaff(async () => { if (Math.random()) notFound(); });
      }
      export async function after() {
        const result = await staffAction({ run: async () => ({ id: '1' }) });
        if (!result.ok) return result;
        go('/x/' + result.id);
      }
    `);
    expect(navigationInsideWrappers(source)).toEqual(['staffAction::go', 'withStaff::notFound']);
  });

  it('leitet nie innerhalb eines Bausteins weiter (Navigation erst nach dem Ergebnis)', () => {
    const hits = actionFiles.flatMap((file) =>
      navigationInsideWrappers(parsed.get(file)!).map((hit) => `${srcRelative(file)}::${hit}`),
    );
    expect(hits).toEqual([]);
  });

  it('klassifiziert die gesamte Server-Action-Fläche', () => {
    const total = [...classified.values()].reduce((sum, styles) => sum + styles.size, 0);
    expect(actionFiles.length).toBeGreaterThan(90);
    expect(total).toBeGreaterThan(350);
  });

  it('friert handgeschriebene Actions pro Datei ein (neue → Wrapper, weniger → Baseline absenken)', () => {
    const baseline = Object.fromEntries(
      Object.entries(HANDWRITTEN_ACTION_BASELINE).map(([file, entry]) => [file, entry.actions]),
    );
    expect(
      handwrittenPerFile(),
      'Handgeschriebene Server-Action: auf withStaff/withPortalContext oder ' +
        'staffAction/portalAction umstellen. Bei Reduktion die Baseline in ' +
        'server-action-style.baseline.ts absenken.\nAktueller Stand:\n' +
        JSON.stringify(handwrittenPerFile(), null, 2),
    ).toEqual(baseline);
  });

  it('begründet jeden Baseline-Eintrag und jede öffentliche Ausnahme', () => {
    for (const entry of Object.values(HANDWRITTEN_ACTION_BASELINE)) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
    for (const reason of Object.values(PUBLIC_ACTION_ENTRY_POINTS)) {
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('hält die öffentlichen Ausnahmen aktuell (Datei bzw. Action existiert)', () => {
    const stale = Object.keys(PUBLIC_ACTION_ENTRY_POINTS).filter((key) => {
      const [file, fn] = key.split('::') as [string, string | undefined];
      const styles = classified.get(file);
      return !styles || (fn !== undefined && styles.get(fn) !== 'public');
    });
    expect(stale).toEqual([]);
  });
});

describe('Action-Boilerplate (R-12)', () => {
  it('erkennt handgefüllte Audit-Akteure und FormData-Feldzugriffe', () => {
    const source = parseFixture(`
      'use server';
      export async function a(formData: FormData, other: Map<string, string>) {
        await evidenceService.record(tx, { tenantId, actorType: 'STAFF', actorId: staffId, action: 'x', resourceType: 'y' });
        await evidenceService.record(tx, event);
        await audit(tx, g, { action: 'x', resourceType: 'y' });
        const name = formData.get('name');
        const ids = formData.getAll('ids');
        return other.get('name');
      }
      export async function b(data: FormData | null) {
        return data?.get('x');
      }
    `);
    expect(handFilledAuditCalls(source)).toBe(2);
    expect(formDataReads(source)).toBe(3);
  });

  it('friert handgefüllte Audit-Akteure pro Datei ein (neu → audit(tx, g, event))', () => {
    const baseline = Object.fromEntries(
      Object.entries(HAND_FILLED_AUDIT_BASELINE).map(([file, entry]) => [file, entry.calls]),
    );
    const current = countPerFile(handFilledAuditCalls);
    expect(
      current,
      'Audit-Akteur von Hand: audit(tx, g, event) aus @/server/actions/audit verwenden. Bei ' +
        'Reduktion die Baseline in server-action-style.baseline.ts absenken.\nAktueller Stand:\n' +
        JSON.stringify(current, null, 2),
    ).toEqual(baseline);
  });

  it('friert FormData-Feldzugriffe pro Datei ein (neu → parseFormData)', () => {
    const baseline = Object.fromEntries(
      Object.entries(FORM_DATA_READ_BASELINE).map(([file, entry]) => [file, entry.reads]),
    );
    const current = countPerFile(formDataReads);
    expect(
      current,
      'FormData Feld für Feld: parseFormData(schema, formData) verwenden. Bei Reduktion die ' +
        'Baseline in server-action-style.baseline.ts absenken.\nAktueller Stand:\n' +
        JSON.stringify(current, null, 2),
    ).toEqual(baseline);
  });

  it('begründet jeden Eintrag der R-12-Baselines', () => {
    for (const entry of [
      ...Object.values(HAND_FILLED_AUDIT_BASELINE),
      ...Object.values(FORM_DATA_READ_BASELINE),
    ]) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });
});
