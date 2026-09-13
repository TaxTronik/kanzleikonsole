// ASSURANCE-RELEASE-EVIDENCE-001: structural coverage is not an executed E2E proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import {
  FULL_E2E_COMMAND,
  checkWorkflow,
  scanTestSources,
  checkDiscovery,
  discoverTests,
} from '../check-paranoid-e2e.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const e2eRequire = createRequire(resolve(ROOT, 'apps/e2e/package.json'));

function workflow() {
  return {
    env: { NODE_ENV: 'test' },
    jobs: {
      'e2e-paranoid': {
        steps: [
          {
            run: 'assert_lock gobd COMPLIANCE 10\nassert_lock gwg GOVERNANCE 5\n--query "ObjectLockConfiguration.Rule.DefaultRetention.[Mode,Years]"',
          },
          { run: FULL_E2E_COMMAND },
        ],
      },
    },
  };
}

function fixture(t) {
  const base = resolve(tmpdir());
  const root = mkdtempSync(resolve(base, 'taxtronik-e2e-guard-'));
  t.after(() => {
    assert.ok(root.startsWith(`${base}${sep}taxtronik-e2e-guard-`));
    rmSync(root, { recursive: true, force: true });
  });
  const tests = resolve(root, 'tests');
  mkdirSync(tests);
  return {
    root,
    tests,
    write(path, content = '') {
      const absolute = resolve(tests, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return absolute;
    },
  };
}

function report(testDir, files) {
  return {
    errors: [],
    config: {
      rootDir: testDir,
      forbidOnly: true,
      shard: null,
      maxFailures: 0,
      projects: [
        { name: 'chromium', testDir, grep: { source: '.*', flags: '' }, grepInvert: null },
      ],
    },
    tests: files.map((file) => ({
      file,
      project: 'chromium',
      expectedStatus: 'passed',
      annotations: [],
    })),
  };
}

test('requires one actual unrestricted run in the paranoid job and preserves its environment', () => {
  const value = workflow();
  value.jobs['e2e-paranoid'].env = { E2E_BASE_URL: 'http://localhost:3000' };
  assert.equal(checkWorkflow(dump(value)).E2E_BASE_URL, 'http://localhost:3000');
  assert.equal(checkWorkflow(dump(value)).CI, 'true');
});

for (const command of [
  `${FULL_E2E_COMMAND} tests/known.spec.ts`,
  `${FULL_E2E_COMMAND} --grep selected`,
  `${FULL_E2E_COMMAND} --grep-invert skipped`,
  `${FULL_E2E_COMMAND} --project chromium`,
  `${FULL_E2E_COMMAND} --shard 1/2`,
  `${FULL_E2E_COMMAND} --last-failed`,
  `${FULL_E2E_COMMAND} --list`,
  `${FULL_E2E_COMMAND} || true`,
  `${FULL_E2E_COMMAND} | cat`,
  `echo '${FULL_E2E_COMMAND}'`,
  `# ${FULL_E2E_COMMAND}\ntrue`,
  `if false; then\n${FULL_E2E_COMMAND}\nfi`,
]) {
  test(`rejects a restricted or non-executing command: ${command}`, () => {
    const value = workflow();
    value.jobs['e2e-paranoid'].steps[1].run = command;
    assert.throws(() => checkWorkflow(dump(value)), /unbeschränkt/);
  });
}

test('a name, comment, other job or duplicate cannot satisfy the required execution', () => {
  for (const mutate of [
    (value) => {
      value.jobs['e2e-paranoid'].steps[1] = { name: FULL_E2E_COMMAND, run: 'true' };
    },
    (value) => {
      value.jobs.smoke = { steps: [value.jobs['e2e-paranoid'].steps.pop()] };
    },
    (value) => {
      value.jobs['e2e-paranoid'].steps.push({ run: FULL_E2E_COMMAND });
    },
  ]) {
    const value = workflow();
    mutate(value);
    assert.throws(() => checkWorkflow(`# ${FULL_E2E_COMMAND}\n${dump(value)}`), /unbeschränkt/);
  }
});

test('rejects bypasses of the mandatory job/step or a different command context', () => {
  for (const [target, field, setting] of [
    ['job', 'if', false],
    ['job', 'continue-on-error', true],
    ['step', 'if', 'false'],
    ['step', 'continue-on-error', true],
    ['step', 'working-directory', 'apps/web'],
    ['step', 'shell', 'echo {0}'],
    ['lock', 'if', false],
  ]) {
    const value = workflow();
    const job = value.jobs['e2e-paranoid'];
    (target === 'job' ? job : job.steps[target === 'lock' ? 0 : 1])[field] = setting;
    assert.throws(() => checkWorkflow(dump(value)));
  }
});

test('preserves each Object-Lock mode/year assertion exactly once and the correct query', () => {
  for (const [before, after] of [
    ['gobd COMPLIANCE 10', 'gobd GOVERNANCE 10'],
    ['gobd COMPLIANCE 10', 'gobd COMPLIANCE 5'],
    ['gwg GOVERNANCE 5', 'gwg COMPLIANCE 5'],
    ['gwg GOVERNANCE 5', 'gwg GOVERNANCE 10'],
    ['assert_lock gobd COMPLIANCE 10', '# assert_lock gobd COMPLIANCE 10'],
    ['assert_lock gwg GOVERNANCE 5', 'assert_lock gwg GOVERNANCE 5\nassert_lock gwg GOVERNANCE 5'],
    ['ObjectLockConfiguration.Rule.DefaultRetention', 'Rule.DefaultRetention'],
    ['--query', '# --query'],
  ]) {
    const value = workflow();
    value.jobs['e2e-paranoid'].steps[0].run = value.jobs['e2e-paranoid'].steps[0].run.replace(
      before,
      after,
    );
    assert.throws(() => checkWorkflow(dump(value)), /Object-Lock/);
  }
});

test('inventory finds arbitrary new and nested specs in every default Playwright source extension', (t) => {
  const f = fixture(t);
  const extensions = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'];
  for (const extension of extensions) {
    f.write(`future/nested/new-feature.spec.${extension}`);
    f.write(`future/another.test.${extension}`);
  }
  f.write('helpers/fixture.ts');
  f.write('readme.md');
  assert.equal(scanTestSources(f.tests).length, 16);
});

test('a new nested spec needs actual discovery but no workflow edit', (t) => {
  const f = fixture(t);
  const first = f.write('existing.spec.ts');
  const discovered = report(f.tests, [first]);
  assert.deepEqual(checkDiscovery(discovered, scanTestSources(f.tests), f.tests), {
    specs: 1,
    tests: 1,
  });
  const added = f.write('unknown/nested/new-feature.test.ts');
  assert.throws(
    () => checkDiscovery(discovered, scanTestSources(f.tests), f.tests),
    /new-feature.test.ts/,
  );
  discovered.tests.push({ ...discovered.tests[0], file: added });
  assert.deepEqual(checkDiscovery(discovered, scanTestSources(f.tests), f.tests), {
    specs: 2,
    tests: 2,
  });
  assert.doesNotThrow(() => checkWorkflow(dump(workflow())));
});

for (const marker of [
  'test.only',
  'test.skip',
  'it.fixme',
  'describe.only',
  'test.describe.skip',
  'test.describe.only',
  "test['skip']",
  'test . describe . fixme',
]) {
  test(`rejects ${marker} in source helpers`, (t) => {
    const f = fixture(t);
    f.write('test.spec.ts');
    f.write('helpers/fixture.ts', `${marker}('temporarily disabled');`);
    assert.throws(() => scanTestSources(f.tests), /Fokus-/);
  });
}

test('rejects empty suites, filtered configuration and runtime skip annotations', (t) => {
  const f = fixture(t);
  assert.throws(() => scanTestSources(f.tests), /Keine E2E/);
  const file = f.write('test.spec.ts');
  for (const mutate of [
    (value) => {
      value.errors.push('import failed');
    },
    (value) => {
      value.config.forbidOnly = false;
    },
    (value) => {
      value.config.shard = { current: 1, total: 2 };
    },
    (value) => {
      value.config.maxFailures = 1;
    },
    (value) => {
      value.config.projects[0].grep.source = 'selected';
    },
    (value) => {
      value.config.projects[0].grepInvert = { source: 'excluded', flags: '' };
    },
    (value) => {
      value.tests[0].expectedStatus = 'skipped';
    },
    (value) => {
      value.tests[0].annotations.push({ type: 'fixme' });
    },
    (value) => {
      value.tests = [];
    },
  ]) {
    const value = report(f.tests, [file]);
    mutate(value);
    assert.throws(() => checkDiscovery(value, [file], f.tests));
  }
});

test('real Playwright discovery covers future nested specs and exposes config filters without services', (t) => {
  const f = fixture(t);
  const cli = e2eRequire.resolve('@playwright/test/cli');
  const playwright = e2eRequire.resolve('@playwright/test');
  const declaration = `const { test } = require(${JSON.stringify(playwright)}); test('one', () => {}); test('two', () => {});`;
  const configPath = resolve(f.root, 'playwright.config.cjs');
  const config =
    "module.exports = { testDir: './tests', forbidOnly: true, projects: [{ name: 'chromium' }]";
  writeFileSync(configPath, `${config} };`);
  f.write('future.spec.ts', declaration);
  f.write('nested/unanticipated.test.ts', declaration);
  const list = () => discoverTests(f.root, { CI: 'true' }, cli);
  assert.deepEqual(checkDiscovery(list(), scanTestSources(f.tests), f.tests), {
    specs: 2,
    tests: 4,
  });
  writeFileSync(configPath, `${config}, grep: /one/ };`);
  assert.throws(() => checkDiscovery(list(), scanTestSources(f.tests), f.tests), /grep/);
  writeFileSync(configPath, `${config}, testIgnore: '**/nested/**' };`);
  assert.throws(
    () => checkDiscovery(list(), scanTestSources(f.tests), f.tests),
    /unanticipated.test.ts/,
  );
  writeFileSync(configPath, `${config}, testMatch: '**/future.spec.ts' };`);
  assert.throws(
    () => checkDiscovery(list(), scanTestSources(f.tests), f.tests),
    /unanticipated.test.ts/,
  );
});
