// Komplexitäts-Baseline je Funktion (Review-Befund B-09, Folgepunkt, Welle 15).
//
// ESLints Bulk-Suppressions zählten Treffer je Datei: Eine neue komplexe
// Funktion in einer Datei mit Altlast fiel nicht auf, solange eine andere
// Funktion derselben Datei einfacher wurde. Die Regel `taxtronik/complexity`
// umhüllt deshalb die Kernregel `complexity` (gleiche Zählung) und vergleicht
// jeden Treffer mit einem Eintrag je Datei + Funktion + Regel:
//
//   { "<Datei>": { "complexity": { "<Funktionsbezeichner>": <erlaubter Wert> } } }
//
// Neue Funktionen über der Grenze und verschlimmerte Funktionen sind Fehler;
// Verbesserungen nicht. `pnpm lint:prune-complexity` senkt die Einträge auf den
// Ist-Stand (nur absenken oder entfernen); `pnpm lint:complexity-baseline`
// übernimmt bewusst den gesamten Ist-Stand. Beide starten einen eigenen
// ESLint-Lauf nur für diese Regel; der Quality-Lauf bleibt bei einem Lauf.
//
// Der Funktionsbezeichner ist positionsunabhängig: Pfad der umschließenden
// Klassen und Funktionen (Name, Variable, Eigenschaft, Aufrufer oder
// JSX-Attribut), gleichnamige Geschwister in Quelltextreihenfolge mit #2, #3.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Öffentlicher, aber als „use at your own risk" markierter Export: liefert die
// Kernregel unverändert. scripts/tests/complexity-baseline.test.mjs prüft, dass
// die Hülle dieselben Werte meldet wie die Kernregel.
import { builtinRules } from 'eslint/use-at-your-own-risk';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE_FILE = 'eslint-complexity-baseline.json';
export const RULE_KEY = 'complexity';
export const RULE_ID = 'taxtronik/complexity';
export const DEFAULT_MAX = 20;

const coreComplexity = builtinRules.get('complexity');

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
const CLASS_TYPES = new Set(['ClassDeclaration', 'ClassExpression']);

/** Repo-relativer POSIX-Pfad oder null außerhalb des Repositorys. */
export function repoPath(filename, root = ROOT) {
  const path = relative(root, filename);
  if (!path || path.startsWith('..') || isAbsolute(path)) return null;
  return path.split(sep).join('/');
}

function propertyKey(node, sourceCode) {
  const key = node.key;
  if (!key) return '[?]';
  if (node.computed) return `[${sourceCode.getText(key)}]`;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (key.type === 'Literal') return String(key.value);
  return sourceCode.getText(key);
}

/** Kurzer, stabiler Text eines Ausdrucks (Leerraum normalisiert). */
function shortText(node, sourceCode) {
  const text = sourceCode.getText(node).replace(/\s+/g, ' ');
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

function calleeLabel(callee, sourceCode) {
  let base = callee;
  while (base.type === 'ChainExpression' || base.type === 'TSNonNullExpression') {
    base = base.expression;
  }
  if (base.type === 'Identifier' || base.type === 'MemberExpression') {
    return shortText(base, sourceCode);
  }
  return 'call';
}

/** Benannte Objektliterale (Variable, Eigenschaft, Zuweisung) sind Pfadsegmente. */
function namedObject(node, parent) {
  if (node.type !== 'ObjectExpression' || !parent) return false;
  return (
    (parent.type === 'VariableDeclarator' && parent.init === node) ||
    (parent.type === 'Property' && parent.value === node) ||
    (parent.type === 'PropertyDefinition' && parent.value === node) ||
    (parent.type === 'AssignmentExpression' && parent.right === node) ||
    parent.type === 'ExportDefaultDeclaration'
  );
}

/** Name eines benannten Objektliterals aus seinem Elternknoten. */
function objectLabel(parent, sourceCode) {
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id.type === 'Identifier' ? parent.id.name : shortText(parent.id, sourceCode);
    case 'Property':
    case 'PropertyDefinition':
      return propertyKey(parent, sourceCode);
    case 'AssignmentExpression':
      return shortText(parent.left, sourceCode);
    default:
      return 'default';
  }
}

/** Bezeichnung eines Funktions-, Klassen-, Objekt- oder Initialisierer-Knotens. */
function containerLabel(node, parent, sourceCode) {
  if (node.type === 'StaticBlock') return 'static {}';
  if (CLASS_TYPES.has(node.type)) return `class ${node.id?.name ?? '(anonym)'}`;
  if (node.type === 'ObjectExpression') return objectLabel(parent, sourceCode);
  if (node.id?.type === 'Identifier') return node.id.name;
  if (!parent) return '(anonym)';
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id.type === 'Identifier' ? parent.id.name : shortText(parent.id, sourceCode);
    case 'MethodDefinition':
      return `${parent.static ? 'static ' : ''}${
        parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ` : ''
      }${parent.kind === 'constructor' ? 'constructor' : propertyKey(parent, sourceCode)}`;
    case 'PropertyDefinition':
      return `${parent.static ? 'static ' : ''}${propertyKey(parent, sourceCode)} =`;
    case 'Property':
      return `${parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ` : ''}${propertyKey(
        parent,
        sourceCode,
      )}`;
    case 'AssignmentExpression':
      return `${shortText(parent.left, sourceCode)} =`;
    case 'AssignmentPattern':
      return `${shortText(parent.left, sourceCode)} = (Standardwert)`;
    case 'ExportDefaultDeclaration':
      return 'default';
    case 'CallExpression':
    case 'NewExpression':
      if (parent.callee === node) return '(sofort aufgerufen)';
      return `${calleeLabel(parent.callee, sourceCode)}(…)`;
    case 'JSXExpressionContainer': {
      const attribute = parent.parent;
      if (attribute?.type === 'JSXAttribute') return `${shortText(attribute.name, sourceCode)}={…}`;
      return '{…}';
    }
    case 'ReturnStatement':
      return 'return';
    default:
      return '(anonym)';
  }
}

/**
 * Bezeichner aller Funktionen, Klassen-Initialisierer und statischen Blöcke
 * einer Datei (dazu Klassen und benannte Objektliterale als Pfadsegmente):
 * Map Knoten -> Bezeichner.
 */
export function functionIdentifiers(sourceCode) {
  const ids = new Map();
  const visitorKeys = sourceCode.visitorKeys;

  function visit(node, parent, scope) {
    let childScope = scope;
    const isInitializer = parent?.type === 'PropertyDefinition' && parent.value === node;
    if (
      FUNCTION_TYPES.has(node.type) ||
      CLASS_TYPES.has(node.type) ||
      node.type === 'StaticBlock' ||
      isInitializer ||
      namedObject(node, parent)
    ) {
      let label = containerLabel(node, parent, sourceCode);
      const count = (scope.counts.get(label) ?? 0) + 1;
      scope.counts.set(label, count);
      if (count > 1) label = `${label}#${count}`;
      const id = scope.prefix ? `${scope.prefix} > ${label}` : label;
      ids.set(node, id);
      childScope = { prefix: id, counts: new Map() };
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child.type === 'string') visit(child, node, childScope);
      } else if (value && typeof value.type === 'string') {
        visit(value, node, childScope);
      }
    }
  }

  visit(sourceCode.ast, null, { prefix: '', counts: new Map() });
  return ids;
}

/** @type {import('eslint').Rule.RuleModule} */
export const complexityRule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Komplexität je Funktion gegen eine Baseline je Datei + Funktion (B-09); Kernregel complexity als Zählung',
    },
    schema: [
      {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 0 },
          baseline: { type: 'object' },
          collect: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      neu:
        '„{{id}}" hat eine Komplexität von {{complexity}} (Grenze {{max}}) und steht nicht in ' +
        `${BASELINE_FILE}. Funktion aufteilen; neue Schuld nur bewusst mit pnpm lint:complexity-baseline.`,
      schlechter:
        '„{{id}}" hat eine Komplexität von {{complexity}}; die Baseline erlaubt {{allowed}} ' +
        '(Grenze {{max}}). Verschlimmerte Altlast nicht hinnehmen, sondern vereinfachen.',
      collect: '{{json}}',
    },
  },
  create(context) {
    const { max = DEFAULT_MAX, baseline = {}, collect = false } = context.options[0] ?? {};
    const file = repoPath(context.filename);
    const allowed = (file && baseline[file]?.[RULE_KEY]) || {};
    const sourceCode = context.sourceCode;
    let ids;

    const proxy = Object.create(context, {
      options: { value: [{ max }] },
      report: {
        value(descriptor) {
          const complexity = Number(descriptor.data?.complexity);
          ids ??= functionIdentifiers(sourceCode);
          const id = ids.get(descriptor.node) ?? `(unbekannt ${descriptor.data?.name ?? ''})`;
          const loc = descriptor.loc;
          if (collect) {
            context.report({
              node: descriptor.node,
              loc,
              messageId: 'collect',
              data: { json: JSON.stringify({ id, complexity }) },
            });
            return;
          }
          const limit = allowed[id];
          if (typeof limit === 'number' && complexity <= limit) return;
          context.report({
            node: descriptor.node,
            loc,
            messageId: typeof limit === 'number' ? 'schlechter' : 'neu',
            data: { id, complexity, max, allowed: limit },
          });
        },
      },
    });
    return coreComplexity.create(proxy);
  },
};

export const complexityPlugin = {
  meta: { name: 'taxtronik-complexity-baseline' },
  rules: { complexity: complexityRule },
};

/** Baseline-Datei lesen; fehlt sie, gilt eine leere Baseline. */
export function readBaseline(root = ROOT) {
  try {
    return JSON.parse(readFileSync(resolve(root, BASELINE_FILE), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

/** Deterministisch sortiert, wie ESLints eslint-suppressions.json. */
export function serializeBaseline(baseline) {
  const sorted = {};
  for (const file of Object.keys(baseline).sort()) {
    const entries = baseline[file]?.[RULE_KEY] ?? {};
    const ids = Object.keys(entries).sort();
    if (ids.length === 0) continue;
    sorted[file] = { [RULE_KEY]: Object.fromEntries(ids.map((id) => [id, entries[id]])) };
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Ist-Stand (Datei -> Funktion -> Komplexität über der Grenze) und Baseline
 * zusammenführen. `prune`: nur absenken oder entfernen, nie hinzufügen oder
 * anheben; sonst den Ist-Stand vollständig übernehmen.
 */
export function mergeBaseline(current, actual, { prune }) {
  if (!prune) return actual;
  const next = {};
  for (const [file, rules] of Object.entries(current)) {
    for (const [id, allowed] of Object.entries(rules?.[RULE_KEY] ?? {})) {
      const now = actual[file]?.[RULE_KEY]?.[id];
      if (typeof now !== 'number') continue;
      next[file] ??= { [RULE_KEY]: {} };
      next[file][RULE_KEY][id] = Math.min(allowed, now);
    }
  }
  return next;
}

/** Ein ESLint-Lauf nur mit dieser Regel im Sammelmodus über `patterns`. */
export async function collectComplexity({ root = ROOT, patterns = ['.'], max = DEFAULT_MAX } = {}) {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({
    cwd: root,
    cache: false,
    ruleFilter: ({ ruleId }) => ruleId === RULE_ID,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        rules: { [RULE_ID]: ['error', { max, baseline: {}, collect: true }] },
      },
    ],
  });
  const results = await eslint.lintFiles(patterns);
  const actual = {};
  for (const result of results) {
    const fatal = result.messages.find((message) => message.fatal);
    if (fatal) throw new Error(`${result.filePath}: ${fatal.message}`);
    const file = repoPath(result.filePath, root);
    for (const message of result.messages) {
      if (message.ruleId !== RULE_ID || !file) continue;
      const { id, complexity } = JSON.parse(message.message);
      actual[file] ??= { [RULE_KEY]: {} };
      if (Object.hasOwn(actual[file][RULE_KEY], id)) {
        throw new Error(`${file}: Funktionsbezeichner doppelt: ${id}`);
      }
      actual[file][RULE_KEY][id] = complexity;
    }
  }
  return actual;
}

async function main(argv) {
  const prune = argv.includes('--prune');
  const write = argv.includes('--write');
  if (prune === write) {
    console.error(
      'Aufruf: node scripts/eslint/complexity-baseline.mjs --prune | --write\n' +
        '  --prune  Einträge auf den Ist-Stand senken bzw. entfernen (nie hinzufügen/anheben)\n' +
        '  --write  Ist-Stand vollständig übernehmen (neue Schuld nur bewusst und begründet)',
    );
    process.exitCode = 2;
    return;
  }
  const current = readBaseline();
  const actual = await collectComplexity();
  const next = serializeBaseline(mergeBaseline(current, actual, { prune }));
  const before = serializeBaseline(current);
  writeFileSync(resolve(ROOT, BASELINE_FILE), next);
  const count = (text) =>
    Object.values(JSON.parse(text)).reduce(
      (sum, rules) => sum + Object.keys(rules[RULE_KEY]).length,
      0,
    );
  console.log(
    `${BASELINE_FILE}: ${count(before)} -> ${count(next)} Funktionen${before === next ? ' (unverändert)' : ''}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FEHLER: ${error.message}`);
    process.exitCode = 1;
  });
}
