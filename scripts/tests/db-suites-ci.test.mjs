// B-02: Jede PostgreSQL-Suite (*-db.test.ts/tsx) laeuft im db-CI-Job.
//
// Der db-Job findet die Suiten je Paket per Glob (scripts/ci/db-suites.mjs);
// dieser Test listet die gefundenen Dateien und prueft fuer jede: genau ein
// Schritt fuehrt sie nach den Migrationen ohne Bedingung aus, ihr Protokoll
// wird archiviert, und die Datei scheitert in CI ohne Opt-in, statt still
// uebersprungen zu werden. Eine neue Suite braucht dafuer keine
// Workflow-Aenderung; fehlt ihr die Wache, schlaegt dieser Test fehl.
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  DB_SUITE_GLOB,
  DB_SUITE_PACKAGES,
  ISOLATED_DB_SUITES,
  checkDbSuitePackages,
  checkDbSuiteWiring,
  dbJobStepFor,
  findDbSuites,
  isolatedDbSuitesOf,
  repositoryReader,
} from '../ci/db-suites.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowText = readFileSync(join(root, '.forgejo/workflows/ci.yml'), 'utf8');
const read = repositoryReader(root);
const files = findDbSuites(root);

const freshWorkflow = () => yaml.load(workflowText);
const webGlobStep = (workflow) =>
  workflow.jobs.db.steps.find((step) =>
    (step.run ?? '').includes('pnpm --filter @taxtronik/web run test:db'),
  );
const GUARDED_SUITE = [
  "const enabled = process.env['NEW_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';",
  "if (!enabled && process.env['CI'] === 'true') {",
  "  throw new Error('NEW_DB_TEST=1 oder DB_TESTS=1 fehlt.');",
  '}',
].join('\n');

test('listet alle DB-Suiten und findet fuer jede genau einen db-Schritt', (t) => {
  t.diagnostic(`${files.length} DB-Suiten per Glob gefunden:\n${files.join('\n')}`);
  for (const pkg of DB_SUITE_PACKAGES) {
    assert.ok(
      files.some((file) => file.startsWith(`${pkg.dir}/`)),
      `${pkg.dir} ohne DB-Suite`,
    );
  }
  const workflow = freshWorkflow();
  assert.deepEqual(checkDbSuiteWiring({ workflow, files, read }), []);
  for (const file of files) {
    const step = dbJobStepFor(workflow, file);
    t.diagnostic(`${file} -> ${step.name}`);
  }
});

test('Paket-Skripte trennen Unit- und Glob-Lauf, die Configs nutzen denselben Glob', () => {
  assert.deepEqual(checkDbSuitePackages({ read }), []);
  for (const pkg of DB_SUITE_PACKAGES) {
    // Was vitest.db.config.ts einschliesst: der Glob ohne die isolierten Suiten.
    const included = globSync(DB_SUITE_GLOB, { cwd: join(root, pkg.dir) })
      .map((file) => `${pkg.dir}/${file.split('\\').join('/')}`)
      .filter((file) => !isolatedDbSuitesOf(pkg.dir).includes(file.slice(pkg.dir.length + 1)))
      .sort();
    const expected = files.filter(
      (file) => file.startsWith(`${pkg.dir}/`) && !(file in ISOLATED_DB_SUITES),
    );
    assert.deepEqual(included, expected, pkg.dir);
  }
});

test('eine neue Suite mit Wache laeuft ohne Workflow-Aenderung im Glob-Schritt', () => {
  const workflow = freshWorkflow();
  const added = 'apps/web/src/server/new-feature/__tests__/new-feature-db.test.ts';
  const reader = (file) => (file === added ? GUARDED_SUITE : read(file));
  assert.deepEqual(checkDbSuiteWiring({ workflow, files: [...files, added], read: reader }), []);
  assert.equal(dbJobStepFor(workflow, added), webGlobStep(workflow));
});

test('meldet Suiten ohne CI-Wache, ohne DB_TESTS und in Paketen ohne Glob-Lauf', () => {
  const workflow = freshWorkflow();
  const unguarded = 'apps/web/src/server/new-feature/__tests__/unguarded-db.test.ts';
  const foreign = 'packages/crypto/src/__tests__/keyring-db.test.ts';
  const reader = (file) =>
    file === unguarded
      ? "const enabled = process.env['NEW_DB_TEST'] === '1';"
      : file === foreign
        ? GUARDED_SUITE
        : read(file);
  const problems = checkDbSuiteWiring({
    workflow,
    files: [...files, unguarded, foreign],
    read: reader,
  });
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.join('\n'), /unguarded-db\.test\.ts: scheitert in CI ohne Opt-in nicht/);
  assert.match(problems.join('\n'), /unguarded-db\.test\.ts: wird nicht per DB_TESTS=1/);
  assert.match(
    problems.join('\n'),
    /keyring-db\.test\.ts: Paket packages\/crypto hat keinen Glob-Lauf/,
  );
});

test('meldet einen Glob-Schritt ohne DB_TESTS, mit Bedingung, vor den Migrationen oder ohne Protokoll', () => {
  const cases = [
    [(step) => delete step.env.DB_TESTS, /setzt DB_TESTS=1 nicht/],
    [(step) => (step.if = "github.event_name == 'push'"), /bedingt oder continue-on-error/],
    [(step) => (step['continue-on-error'] = true), /bedingt oder continue-on-error/],
    [
      (step) => (step.run = 'pnpm --filter @taxtronik/web run test:db'),
      /protokolliert nicht mit pipefail und tee/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const workflow = freshWorkflow();
    mutate(webGlobStep(workflow));
    const problems = checkDbSuiteWiring({ workflow, files, read });
    assert.match(problems.join('\n'), pattern);
  }

  const early = freshWorkflow();
  const steps = early.jobs.db.steps;
  steps.unshift(...steps.splice(steps.indexOf(webGlobStep(early)), 1));
  assert.match(
    checkDbSuiteWiring({ workflow: early, files, read }).join('\n'),
    /laeuft vor den Migrationen/,
  );

  const unarchived = freshWorkflow();
  const upload = unarchived.jobs.db.steps.find((step) => step.with?.name === 'testbericht-db');
  upload.with.path = upload.with.path.replace('testbericht-web-db.log', '');
  assert.match(
    checkDbSuiteWiring({ workflow: unarchived, files, read }).join('\n'),
    /testbericht-web-db\.log fehlt im Artefakt testbericht-db/,
  );
});

test('meldet DB_TESTS im Quality-Job und isolierte Suiten ohne eigenen Schritt', () => {
  const quality = freshWorkflow();
  quality.jobs.quality.env = { DB_TESTS: '1' };
  assert.match(
    checkDbSuiteWiring({ workflow: quality, files, read }).join('\n'),
    /DB_TESTS gehoert nur in den db-Job/,
  );

  const isolated = Object.keys(ISOLATED_DB_SUITES)[0];
  const missing = freshWorkflow();
  missing.jobs.db.steps = missing.jobs.db.steps.filter(
    (step) => !(step.run ?? '').includes(isolated.slice('apps/web/'.length)),
  );
  assert.match(
    checkDbSuiteWiring({ workflow: missing, files, read }).join('\n'),
    /service-db\.test\.ts: kein \(eindeutiger\) Schritt im db-Job/,
  );
});

test('meldet Unit-Laeufe ohne Ausschluss und Glob-Configs ohne Serialisierung', () => {
  const reader = (file) => {
    if (file === 'apps/worker/package.json') {
      return JSON.stringify({ scripts: { test: 'vitest run', 'test:db': 'vitest run' } });
    }
    if (file === 'packages/evidence/vitest.db.config.ts') {
      return read(file).replace('fileParallelism: false', 'fileParallelism: true');
    }
    return read(file);
  };
  const problems = checkDbSuitePackages({ read: reader }).join('\n');
  assert.match(problems, /apps\/worker: "test" muss/);
  assert.match(problems, /apps\/worker: "test:db" muss/);
  assert.match(
    problems,
    /packages\/evidence\/vitest\.db\.config\.ts: "fileParallelism: false" fehlt/,
  );
});
