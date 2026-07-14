// =============================================================================
// Struktur-Guardrail: fachliche n8n-Events müssen ihren Tenant im dritten
// emitN8nEvent-Argument übergeben. Ein tenantId-Feld nur im Payload reicht
// nicht: Routing, Secret-Auflösung und RLS verwenden ausschließlich opts.tenantId.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function walkProductionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__') files.push(...walkProductionSources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.(?:test|spec)\.tsx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

interface EmitCall {
  file: string;
  line: number;
  hasExplicitTenant: boolean;
  isAwaited: boolean;
}

function hasAwaitAncestor(node: ts.Node, source: ts.SourceFile): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent && parent !== source) {
    if (ts.isAwaitExpression(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

function collectEmitCalls(file: string): EmitCall[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('emitN8nEvent')) return [];

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const localNames = new Set<string>();
  const namespaceNames = new Set<string>();

  source.forEachChild((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== '@/server/n8n/emit'
    ) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if ((specifier.propertyName ?? specifier.name).text === 'emitN8nEvent') {
          localNames.add(specifier.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceNames.add(bindings.name.text);
    }
  });

  const calls: EmitCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const direct = ts.isIdentifier(node.expression) && localNames.has(node.expression.text);
      const namespaced =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaceNames.has(node.expression.expression.text) &&
        node.expression.name.text === 'emitN8nEvent';
      if (direct || namespaced) {
        const event = node.arguments[0];
        const isSystemPing = Boolean(
          event && ts.isStringLiteral(event) && event.text === 'taxtronik.ping',
        );
        const options = node.arguments[2];
        const hasExplicitTenant =
          isSystemPing ||
          Boolean(
            options &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.some(
              (property) =>
                (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
                property.name.getText(source) === 'tenantId',
            ),
          );
        calls.push({
          file: relative(SRC_DIR, file).replace(/\\/g, '/'),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          hasExplicitTenant,
          isAwaited: hasAwaitAncestor(node, source),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return calls;
}

describe('n8n Business-Events tragen immer einen expliziten Tenant', () => {
  const calls = walkProductionSources(SRC_DIR).flatMap(collectEmitCalls);

  it('findet die produktive Emit-Fläche', () => {
    expect(calls.length).toBeGreaterThan(10);
  });

  it('hat an jedem Business-Callsite { tenantId } im Options-Argument', () => {
    const missing = calls
      .filter((call) => !call.hasExplicitTenant)
      .map((call) => `${call.file}:${call.line}`)
      .sort();
    expect(
      missing,
      `emitN8nEvent ohne explizites drittes { tenantId }-Argument: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('wartet an jedem Callsite den dauerhaften Outbox-Write ab', () => {
    const unawaited = calls
      .filter((call) => !call.isAwaited)
      .map((call) => `${call.file}:${call.line}`)
      .sort();
    expect(unawaited, `emitN8nEvent ohne await: ${unawaited.join(', ')}`).toEqual([]);
  });
});
