// =============================================================================
// Gemeinsame Erkennung der Server-Action-Module fuer die AST-Guardrails
// (server-action-authz, action-result-contract).
//
// Massgeblich ist allein die Direktive: Next.js behandelt jede Datei, deren
// Direktiven-Prolog `'use server'` enthaelt, als Server-Action-Modul — jeder
// exportierte Funktionswert ist dann per POST aufrufbar, egal wie die Datei
// heisst. Ein Dateinamensfilter (`*actions.ts`) uebersieht solche Module, ein
// reiner Textvergleich zaehlt dagegen Kommentare wie „Bewusst OHNE
// 'use server'" oder Barrel-Dateien ohne Direktive mit.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.next', 'coverage']);

/** Alle produktiven .ts/.tsx-Quellen unterhalb von `dir` (ohne Testordner und .d.ts). */
export function walkProductSources(dir: string): string[] {
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

export function parseSource(file: string, text = readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** True, wenn der Direktiven-Prolog (fuehrende String-Anweisungen) `'use server'` enthaelt. */
export function hasUseServerDirective(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === 'use server') return true;
  }
  return false;
}

/** Alle Server-Action-Module unterhalb von `dir`, sortiert. */
export function serverActionSourceFiles(dir: string): string[] {
  return walkProductSources(dir)
    .filter((file) => hasUseServerDirective(parseSource(file)))
    .sort();
}
