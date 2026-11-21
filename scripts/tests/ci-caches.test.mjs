// B-03: Caches im CI-Workflow (Turbo, Next/Turbopack, Playwright-Browser).
//
// Ein Cache darf nur beschleunigen, nie ein Ergebnis ersetzen. Geprüft wird
// deshalb, dass jeder Cache-Pfad genau dort liegt, wo das Werkzeug schreibt und
// liest, dass er vor seinem Verbraucher wiederhergestellt wird und dass der
// Schlüssel an den Dateien hängt, die den Inhalt bestimmen: Lockfile (Turbo,
// Next) bzw. browsers.json des installierten playwright-core (Browser-Revision).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_ACTION = 'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830'; // v4.3.0
const workflow = yaml.load(readFileSync(join(ROOT, '.forgejo/workflows/ci.yml'), 'utf8'));
const LOCKFILE_HASH = "hashFiles('pnpm-lock.yaml'";

function cacheStep(job, path) {
  const steps = workflow.jobs[job].steps.filter(
    (step) => step.uses?.startsWith('actions/cache@') && step.with?.path === path,
  );
  assert.equal(steps.length, 1, `${job}: genau ein Cache-Schritt für ${path}`);
  return steps[0];
}

function indexOfRun(job, run) {
  const index = workflow.jobs[job].steps.findIndex((step) => step.run?.trim() === run);
  assert.ok(index >= 0, `${job}: Schritt "${run}" fehlt`);
  return index;
}

test('jede Cache-Action ist dieselbe gepinnte v4.3.0', () => {
  for (const file of readdirSync(join(ROOT, '.forgejo/workflows'))) {
    const source = readFileSync(join(ROOT, '.forgejo/workflows', file), 'utf8');
    for (const match of source.matchAll(/uses:\s*(actions\/cache(?:\/\w+)?@\S+)(.*)$/gm)) {
      assert.equal(match[1], CACHE_ACTION, `${file}: ${match[0]}`);
      assert.match(match[2], /# v4\.3\.0/, `${file}: Versionskommentar`);
    }
  }
});

test('Turbo-Cache liegt am TURBO_CACHE_DIR und kommt vor pnpm typecheck', () => {
  const typecheck = workflow.jobs.typecheck;
  assert.equal(typecheck.env?.TURBO_CACHE_DIR, '.turbo/cache');
  // Der Unit-Job nutzt denselben Ort; `test` spielt Turbo nie aus dem Cache ab.
  assert.equal(workflow.jobs['unit-tests'].env?.TURBO_CACHE_DIR, '.turbo/cache');
  const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
  assert.equal(turbo.cacheDir, undefined, 'turbo.json darf den Ort nicht abweichend setzen');
  const step = cacheStep('typecheck', typecheck.env.TURBO_CACHE_DIR);
  assert.ok(typecheck.steps.indexOf(step) < indexOfRun('typecheck', 'pnpm typecheck'));
  assert.ok(step.with.key.includes(LOCKFILE_HASH) && step.with.key.includes('github.sha'));
  assert.ok(step.with['restore-keys'].includes(LOCKFILE_HASH));
});

test('Next-Cache liegt unter apps/web/.next/cache und kommt vor dem Build', () => {
  const step = cacheStep('e2e-paranoid', 'apps/web/.next/cache');
  const steps = workflow.jobs['e2e-paranoid'].steps;
  assert.ok(steps.indexOf(step) < indexOfRun('e2e-paranoid', 'pnpm --filter @taxtronik/web build'));
  assert.ok(step.with.key.includes(LOCKFILE_HASH));
  assert.ok(step.with.key.includes("'apps/web/next.config.mjs'"));
  assert.ok(existsSync(join(ROOT, 'apps/web/next.config.mjs')));
});

const e2eExec = 'pnpm --filter @taxtronik/e2e exec';
const browserManifest = 'node_modules/playwright-core/browsers.json';
const browserCacheVersion =
  "${{ runner.os }}-${{ hashFiles('node_modules/playwright-core/browsers.json') }}";
const browserJobs = [
  { job: 'e2e-paranoid', engines: ['chromium'], install: 'chromium --with-deps', run: 'test' },
  {
    job: 'ui-browser',
    engines: ['chromium', 'firefox'],
    install: '--with-deps chromium firefox',
    run: 'test --config=playwright.ui.config.ts',
  },
];

for (const { job, engines, install, run } of browserJobs) {
  test(`${job}: Installer und Browserstart verwenden die gecachten Revisionen`, () => {
    const { env, steps } = workflow.jobs[job];
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '.cache/ms-playwright');
    const cache = steps.filter(
      (step) => step.uses === CACHE_ACTION && step.with?.key.includes(browserManifest),
    );
    assert.equal(cache.length, 1, `${job}: genau ein Browser-Cache`);
    const [step] = cache;
    const setup = steps.findIndex((item) =>
      /scripts\/ci\/setup\.sh install\b/.test(item.run ?? ''),
    );
    const restore = steps.indexOf(step);
    const download = indexOfRun(job, `${e2eExec} playwright install ${install}`);
    const tests = indexOfRun(job, `${e2eExec} playwright ${run}`);
    assert.ok(setup >= 0 && setup < restore && restore < download && download < tests);
    for (const item of steps.filter((item) => /\bplaywright\b/.test(item.run ?? ''))) {
      assert.ok(item.run.trim().startsWith(`${e2eExec} playwright `), item.run);
    }

    // pnpm setzt INIT_CWD bei diesem Aufruf selbst. Der Installer gibt mit
    // --dry-run seine tatsächlichen Zielpfade aus, ohne Browser zu laden.
    const childEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH };
    delete childEnv.INIT_CWD;
    const opts = { cwd: ROOT, env: childEnv, encoding: 'utf8' };
    const plan = execSync(`${e2eExec} playwright install --dry-run ${engines.join(' ')}`, opts);
    const destinations = Array.from(plan.matchAll(/^\s*Install location:\s*(.+)$/gm), (match) =>
      match[1].trim(),
    );
    const cacheDir = resolve(ROOT, step.with.path);
    assert.deepEqual(
      [...new Set(destinations.map(dirname))],
      [cacheDir],
      'CLI-Installationsziele im Cache',
    );
    const lookup = JSON.parse(
      execSync(
        `${e2eExec} node -p "JSON.stringify({chromium: require('playwright').chromium.executablePath(), firefox: require('playwright').firefox.executablePath()})"`,
        opts,
      ),
    );

    const fromE2e = createRequire(join(ROOT, 'apps/e2e/package.json'));
    const playwright = fromE2e.resolve('playwright/package.json');
    const core = createRequire(playwright).resolve('playwright-core/package.json');
    assert.equal(join(dirname(core), 'browsers.json'), join(ROOT, browserManifest));
    const { browsers } = JSON.parse(readFileSync(join(ROOT, browserManifest), 'utf8'));
    for (const name of engines) {
      const { revision } = browsers.find((item) => item.name === name);
      assert.ok(revision);
      const directory = join(cacheDir, `${name}-${revision}`);
      assert.ok(destinations.includes(directory), `Installationsrevision für ${name}`);
      assert.ok(lookup[name].startsWith(directory + sep), `Browserstart aus ${directory}`);
    }
    assert.equal(step.with.key, `playwright-${engines.join('-')}-${browserCacheVersion}`);
  });
}
