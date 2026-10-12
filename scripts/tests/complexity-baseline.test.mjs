// B-09 (Folgepunkt, Welle 15): Komplexitäts-Baseline je Funktion statt je Datei.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import {
  BASELINE_FILE,
  DEFAULT_MAX,
  ROOT,
  RULE_ID,
  RULE_KEY,
  collectComplexity,
  complexityPlugin,
  mergeBaseline,
  readBaseline,
  serializeBaseline,
} from '../eslint/complexity-baseline.mjs';

const FILE = 'apps/web/src/fixture/complex.tsx';

function lint(code, { max = 2, baseline = {}, collect = false, core = false } = {}) {
  const linter = new Linter({ configType: 'flat', cwd: ROOT });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { taxtronik: complexityPlugin },
        rules: core
          ? { complexity: ['error', max] }
          : { [RULE_ID]: ['error', { max, baseline, collect }] },
      },
    ],
    { filename: resolve(ROOT, FILE) },
  );
}

const collected = (code, options) =>
  lint(code, { ...options, collect: true }).map((message) => {
    assert.equal(message.ruleId, RULE_ID, message.message);
    return JSON.parse(message.message);
  });

const baselineFor = (entries) => ({ [FILE]: { [RULE_KEY]: entries } });

// Komplexität: a = 4 (drei if), b = 3 (zwei if), c = 1.
const A = 'function a(x) { if (x) {} if (x > 1) {} if (x > 2) {} }';
const B = 'function b(x) { if (x) {} if (x > 1) {} }';
const C = 'function c() { return 1; }';

test('the wrapper reports exactly the complexity of the core rule', () => {
  const code = `
    ${A}
    ${B}
    const d = (x) => x?.y ?? (x || 1);
    class K { m(x) { for (const i of x) { if (i) return i; } } static { if (globalThis.z) {} } f = (x) => (x ? 1 : 2); }
    export default function (x = 1) { try { return x && 2; } catch { return 0; } }
  `;
  const core = lint(code, { max: 0, core: true }).map((m) => [
    m.line,
    Number(/complexity of (\d+)/.exec(m.message)[1]),
  ]);
  const wrapped = lint(code, { max: 0, collect: true }).map((m) => [
    m.line,
    JSON.parse(m.message).complexity,
  ]);
  assert.ok(core.length >= 8, `zu wenige Kernmeldungen: ${core.length}`);
  assert.deepEqual(wrapped, core);
});

test('a new complex function fails even when another function of the file got simpler', () => {
  // Früher (Zähler je Datei): a sinkt unter die Grenze, b wird komplex — der
  // Zähler bleibt bei 1 und nichts fällt auf. Jetzt ist b als neue Funktion
  // ein Fehler.
  const baseline = baselineFor({ a: 4 });
  assert.deepEqual(lint(`${A}\n${C}`, { baseline }), []);
  const messages = lint(`function a(x) { if (x) {} }\n${B}`, { baseline });
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /^„b" hat eine Komplexität von 3 \(Grenze 2\) und steht nicht/);
  assert.equal(messages[0].line, 2);
});

test('a worsened baseline function fails, an equal or improved one passes', () => {
  assert.deepEqual(lint(A, { baseline: baselineFor({ a: 4 }) }), []);
  assert.deepEqual(lint(A, { baseline: baselineFor({ a: 5 }) }), []);
  assert.deepEqual(
    lint(B.replace('function b', 'function a'), { baseline: baselineFor({ a: 4 }) }),
    [],
  );
  const worse = lint(A, { baseline: baselineFor({ a: 3 }) });
  assert.equal(worse.length, 1);
  assert.match(worse[0].message, /„a" hat eine Komplexität von 4; die Baseline erlaubt 3/);
});

test('entries are bound to the file: the same name in another file is new', () => {
  const other = { 'apps/web/src/fixture/other.tsx': { [RULE_KEY]: { a: 9 } } };
  assert.equal(lint(A, { baseline: other }).length, 1);
});

test('identifiers do not depend on position: moving code and adding lines keeps entries', () => {
  const baseline = baselineFor({ a: 4, 'class K > m': 4, 'list > items.map(…)': 3 });
  const first = `
    ${A}
    class K { m(x) { if (x) {} if (x > 1) {} if (x > 2) {} } }
    function list(items) { return items.map((i) => { if (i) {} if (i > 1) {} }); }
  `;
  const moved = `
    // neuer Kopf


    function list(items) { return items.map((i) => { if (i) {} if (i > 1) {} }); }
    ${C}
    class K { m(x) { if (x) {} if (x > 1) {} if (x > 2) {} } }
    ${A}
  `;
  assert.deepEqual(lint(first, { baseline }), []);
  assert.deepEqual(lint(moved, { baseline }), []);
});

test('identifiers name the context of methods, callbacks, handlers and anonymous code', () => {
  const ifs = 'if (x) {} if (x > 1) {}';
  const code = `
    export default function (x) { ${ifs} }
    const arrow = (x) => { ${ifs} };
    const obj = { prop(x) { ${ifs} }, get g() { const x = 1; ${ifs} return 1; } };
    module.exports.handler = function (x) { ${ifs} };
    class Box {
      static s(x) { ${ifs} }
      field = (x) => { ${ifs} };
      static { const x = 1; ${ifs} }
    }
    function outer(items) {
      items.map((x) => { ${ifs} });
      items.map((x) => { ${ifs} });
      return <button onClick={(x) => { ${ifs} }} />;
    }
    ((x) => { ${ifs} })(1);
  `;
  assert.deepEqual(
    collected(code).map((entry) => entry.id),
    [
      'default',
      'arrow',
      'obj > prop',
      'obj > get g',
      'module.exports.handler =',
      'class Box > static s',
      'class Box > field =',
      'class Box > static {}',
      'outer > items.map(…)',
      'outer > items.map(…)#2',
      'outer > onClick={…}',
      '(sofort aufgerufen)',
    ],
  );
});

test('prune only lowers or removes entries, write takes the actual state', () => {
  const current = {
    'a.ts': { [RULE_KEY]: { kept: 30, lowered: 30, gone: 25 } },
    'b.ts': { [RULE_KEY]: { removed: 22 } },
  };
  const actual = {
    'a.ts': { [RULE_KEY]: { kept: 30, lowered: 24, raised: 40 } },
    'c.ts': { [RULE_KEY]: { added: 21 } },
  };
  assert.deepEqual(mergeBaseline(current, actual, { prune: true }), {
    'a.ts': { [RULE_KEY]: { kept: 30, lowered: 24 } },
  });
  assert.deepEqual(mergeBaseline(current, actual, { prune: false }), actual);
  const worse = { 'a.ts': { [RULE_KEY]: { kept: 35 } } };
  assert.deepEqual(mergeBaseline(current, worse, { prune: true }), {
    'a.ts': { [RULE_KEY]: { kept: 30 } },
  });
});

test('the committed baseline is sorted, above the limit and names existing files', () => {
  const raw = readFileSync(resolve(ROOT, BASELINE_FILE), 'utf8');
  const baseline = readBaseline();
  assert.equal(serializeBaseline(baseline), raw);
  assert.ok(Object.keys(baseline).length > 0);
  for (const [file, rules] of Object.entries(baseline)) {
    assert.ok(existsSync(resolve(ROOT, file)), `${file} fehlt`);
    assert.deepEqual(Object.keys(rules), [RULE_KEY], file);
    for (const [id, value] of Object.entries(rules[RULE_KEY])) {
      assert.ok(Number.isInteger(value) && value > DEFAULT_MAX, `${file} › ${id}: ${value}`);
    }
  }
  // Die frühere Zähler-Baseline je Datei ist ersetzt, nicht ergänzt.
  assert.equal(existsSync(resolve(ROOT, 'eslint-suppressions.json')), false);
});

test('the repository config runs the baseline rule for TypeScript instead of the core rule', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  for (const file of ['apps/web/src/app/layout.tsx', 'packages/http-utils/src/index.ts']) {
    const config = await eslint.calculateConfigForFile(resolve(ROOT, file));
    const [severity, options] = config.rules[RULE_ID];
    assert.equal(severity, 2, file);
    assert.equal(options.max, DEFAULT_MAX);
    assert.deepEqual(options.baseline, readBaseline());
    assert.ok(!config.rules.complexity || config.rules.complexity[0] === 0, file);
  }
});

test('collecting through the repository config finds the recorded functions', async () => {
  const file = 'packages/http-utils/src/index.ts';
  const actual = await collectComplexity({ patterns: [file] });
  assert.deepEqual(actual, { [file]: readBaseline()[file] });
});
