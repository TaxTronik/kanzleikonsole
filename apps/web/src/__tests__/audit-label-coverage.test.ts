// =============================================================================
// Coverage-Guardrail: jede Audit-Action, die über evidenceService.record(...)
// emittiert wird, MUSS ein deutsches Label in ACTION_LABELS haben — sonst rendern
// die freundlichen Views (Dashboard, Mandanten-Aktivitätsstrom, Notifications)
// den Roh-Key (z. B. „risk.analysis.reformatted"). Fängt die „vergessene
// Label-Zeile" über die ganze Emit-Fläche ab — statisch über den TS-AST, ohne DB.
//
// Pendant zum Authz-Struktur-Guardrail (server-action-authz.test.ts).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { ACTION_LABELS } from '../server/audit/labels';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Actions, die per Template-Literal dynamisch gebaut werden (statisch nicht
// auflösbar) — ihre konkreten Ausprägungen hier explizit führen. Sie müssen
// ebenfalls ein Label haben.
const KNOWN_DYNAMIC_ACTIONS = [
  // dsgvo/actions.ts: `dsgvo.request.${status.toLowerCase()}`
  'dsgvo.request.received',
  'dsgvo.request.in_progress',
  'dsgvo.request.completed',
  'dsgvo.request.rejected',
];

// Bewusst NUR in der technischen Compliance-View (Roh-String), kein freundliches
// Label gewünscht. Aktuell leer — jede emittierte Action soll ein Label haben.
const LABEL_ALLOWLIST = new Set<string>([]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Sammelt alle `action`-String-Werte aus `evidenceService.record(...)`-Aufrufen
 * der Datei. Ternary-Zweige werden beide erfasst; Template-Literale als
 * „dynamisch" markiert (separat über KNOWN_DYNAMIC_ACTIONS geprüft).
 */
function collectEmittedActions(file: string, sink: Set<string>): boolean {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('evidenceService.record')) return false;
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let sawDynamic = false;

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'record' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'evidenceService'
    ) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop) || prop.name.getText(src) !== 'action') continue;
          const init = prop.initializer;
          if (ts.isStringLiteralLike(init)) {
            sink.add(init.text);
          } else if (ts.isConditionalExpression(init)) {
            for (const branch of [init.whenTrue, init.whenFalse]) {
              if (ts.isStringLiteralLike(branch)) sink.add(branch.text);
            }
          } else if (ts.isTemplateExpression(init)) {
            sawDynamic = true;
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(src);
  return sawDynamic;
}

const emitted = new Set<string>();
for (const f of walk(SRC_DIR)) collectEmittedActions(f, emitted);

describe('Audit-Action-Labels sind vollständig (Coverage-Guardrail)', () => {
  it('findet die Audit-Emit-Fläche', () => {
    expect(emitted.size).toBeGreaterThan(100);
  });

  it('jede statisch emittierte Action hat ein deutsches Label', () => {
    const missing = [...emitted]
      .filter((a) => !LABEL_ALLOWLIST.has(a) && !(a in ACTION_LABELS))
      .sort();
    expect(missing, `Actions ohne ACTION_LABELS-Eintrag: ${missing.join(', ')}`).toEqual([]);
  });

  it('bekannte dynamische (Template-Literal) Actions haben ein Label', () => {
    const missing = KNOWN_DYNAMIC_ACTIONS.filter((a) => !(a in ACTION_LABELS)).sort();
    expect(missing, `Dynamische Actions ohne Label: ${missing.join(', ')}`).toEqual([]);
  });
});
