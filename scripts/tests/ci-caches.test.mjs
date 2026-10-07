// B-03: Caches im CI-Workflow (Turbo, Next/Turbopack, Playwright-Browser).
//
// Ein Cache darf nur beschleunigen, nie ein Ergebnis ersetzen. Geprüft wird
// deshalb, dass jeder Cache-Pfad genau dort liegt, wo das Werkzeug schreibt und
// liest, dass er vor seinem Verbraucher wiederhergestellt wird und dass der
// Schlüssel an den Dateien hängt, die den Inhalt bestimmen: Lockfile (Turbo,
// Next) bzw. browsers.json des installierten playwright-core (Browser-Revision).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
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
  const quality = workflow.jobs.quality;
  assert.equal(quality.env?.TURBO_CACHE_DIR, '.turbo/cache');
  const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
  assert.equal(turbo.cacheDir, undefined, 'turbo.json darf den Ort nicht abweichend setzen');
  const step = cacheStep('quality', quality.env.TURBO_CACHE_DIR);
  assert.ok(quality.steps.indexOf(step) < indexOfRun('quality', 'pnpm typecheck'));
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

test('Playwright-Cache: fester Browser-Ort, Schlüssel aus browsers.json', () => {
  const e2e = workflow.jobs['e2e-paranoid'];
  const browsersPath = e2e.env?.PLAYWRIGHT_BROWSERS_PATH;
  assert.equal(browsersPath, '.cache/ms-playwright');
  // Playwright löst einen relativen Pfad gegen das Arbeitsverzeichnis auf; beide
  // Aufrufe laufen per `pnpm --filter @taxtronik/e2e exec` in apps/e2e.
  const install = 'pnpm --filter @taxtronik/e2e exec playwright install chromium --with-deps';
  const run = 'pnpm --filter @taxtronik/e2e exec playwright test';
  for (const step of [install, run]) indexOfRun('e2e-paranoid', step);
  for (const step of e2e.steps) {
    if (
      /\bplaywright\b/.test(step.run ?? '') &&
      !/^pnpm --filter @taxtronik\/e2e exec playwright /.test(step.run.trim())
    ) {
      assert.fail(`Playwright-Aufruf außerhalb von apps/e2e: ${step.run.trim()}`);
    }
  }
  const step = cacheStep('e2e-paranoid', 'apps/e2e/.cache/ms-playwright');
  assert.equal(resolve(ROOT, 'apps/e2e', browsersPath), join(ROOT, step.with.path));
  assert.equal(
    step.with.key,
    "playwright-${{ runner.os }}-${{ hashFiles('node_modules/playwright-core/browsers.json') }}",
  );
  // Nach der Installation (browsers.json existiert erst dann), vor dem Download.
  const setup = e2e.steps.findIndex((item) =>
    /scripts\/ci\/setup\.sh install\b/.test(item.run ?? ''),
  );
  assert.ok(setup >= 0 && setup < e2e.steps.indexOf(step));
  assert.ok(e2e.steps.indexOf(step) < indexOfRun('e2e-paranoid', install));
  // Die E2E-Suite löst genau das playwright-core auf, dessen browsers.json den Schlüssel bildet.
  const fromE2e = createRequire(join(ROOT, 'apps/e2e/package.json'));
  const playwright = fromE2e.resolve('playwright/package.json');
  const core = createRequire(playwright).resolve('playwright-core/package.json');
  assert.equal(core, join(ROOT, 'node_modules/playwright-core/package.json'));
  const browsers = JSON.parse(
    readFileSync(join(ROOT, 'node_modules/playwright-core/browsers.json'), 'utf8'),
  ).browsers;
  assert.ok(browsers.some((browser) => browser.name === 'chromium' && browser.revision));
});
