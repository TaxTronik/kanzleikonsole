import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

export const FULL_E2E_COMMAND = 'pnpm --filter @taxtronik/e2e exec playwright test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTER = resolve(ROOT, 'scripts/paranoid-e2e-reporter.mjs');

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function requireBlocking(scope, label) {
  requireThat(!Object.hasOwn(scope, 'if'), `${label}: bedingte Ausführung ist nicht vollständig.`);
  requireThat(
    !scope['continue-on-error'],
    `${label}: continue-on-error darf den Pflichtnachweis nicht umgehen.`,
  );
}

export function checkWorkflow(source) {
  const workflow = load(source);
  const job = workflow?.jobs?.['e2e-paranoid'];
  requireThat(job && Array.isArray(job.steps), 'CI-Job e2e-paranoid mit Steps fehlt.');
  requireBlocking(job, 'e2e-paranoid');
  const runs = job.steps.filter((step) => typeof step.run === 'string');
  // Exact executable scalar, not a comment, step name, echoed command or partial run.
  const fullRuns = runs.filter((step) => step.run.trim() === FULL_E2E_COMMAND);
  requireThat(
    fullRuns.length === 1,
    `e2e-paranoid muss genau einmal unbeschränkt ausführen: ${FULL_E2E_COMMAND}`,
  );
  const testStep = fullRuns[0];
  requireBlocking(testStep, 'Vollständiger E2E-Lauf');
  for (const scope of [workflow.defaults?.run, job.defaults?.run, testStep]) {
    if (!scope) continue;
    requireThat(
      !scope['working-directory'] || scope['working-directory'] === '.',
      'Der vollständige E2E-Aufruf muss im Repository-Root laufen.',
    );
    requireThat(
      !scope.shell || scope.shell === 'bash',
      'E2E-Aufruf darf keinen Shell-Wrapper haben.',
    );
  }

  // Keep the existing Mode/Years and query protections for both archive buckets.
  const lockSteps = runs.filter((step) => /assert_lock\s+(gobd|gwg)\s/.test(step.run));
  lockSteps.forEach((step) => requireBlocking(step, 'Object-Lock-Prüfung'));
  const lockSource = lockSteps.map((step) => step.run.replace(/^\s*#.*$/gm, '')).join('\n');
  for (const [bucket, mode, years] of [
    ['gobd', 'COMPLIANCE', '10'],
    ['gwg', 'GOVERNANCE', '5'],
  ]) {
    const assertions = [
      ...lockSource.matchAll(
        new RegExp(`^[ \\t]*assert_lock[ \\t]+${bucket}[ \\t]+([^\\r\\n]+)`, 'gm'),
      ),
    ];
    requireThat(
      assertions.length === 1 &&
        assertions[0][1].trim().split(/\s+/).join(' ') === `${mode} ${years}`,
      `Object-Lock-Prüfung für ${bucket} muss exakt einmal ${mode}/${years} Jahre erwarten.`,
    );
  }
  requireThat(
    lockSource.includes('--query "ObjectLockConfiguration.Rule.DefaultRetention.[Mode,Years]"'),
    'Object-Lock-Query muss bei ObjectLockConfiguration.Rule beginnen und Mode/Years prüfen.',
  );

  const env = { CI: 'true', ...workflow.env, ...job.env, ...testStep.env };
  for (const [key, value] of Object.entries(env)) {
    requireThat(
      ['string', 'number', 'boolean'].includes(typeof value) && !String(value).includes('${{'),
      `E2E-Umgebung ${key} kann für die Discovery nicht eindeutig aufgelöst werden.`,
    );
    env[key] = String(value);
  }
  return env;
}

export function scanTestSources(testDir) {
  const specs = [];
  // Preserve the source guard, including markers inside helpers and describe chains.
  const forbidden =
    /\b(?:test|it|describe)(?:\s*\.\s*\w+)*\s*(?:\.\s*(?:only|skip|fixme|todo)\b|\[\s*['"](?:only|skip|fixme|todo)['"]\s*\])/;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      requireThat(!entry.isSymbolicLink(), `E2E-Inventur benötigt reguläre Dateien: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        requireThat(
          !forbidden.test(readFileSync(path, 'utf8')),
          `E2E darf keine Fokus-/Skip-Marker enthalten: ${path}`,
        );
        if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) specs.push(path);
      }
    }
  }
  visit(testDir);
  requireThat(
    specs.length > 0,
    'Keine E2E-Specs gefunden. Vollständige Testabdeckung wiederherstellen.',
  );
  return specs.sort();
}

export function checkDiscovery(report, specs, testDir) {
  requireThat(
    Array.isArray(report.errors) && report.errors.length === 0,
    `Playwright-Discovery fehlgeschlagen: ${report.errors?.join('\n')}`,
  );
  const config = report.config;
  requireThat(config?.forbidOnly === true, 'Playwright muss in CI forbidOnly aktivieren.');
  requireThat(
    !config.shard && config.maxFailures === 0,
    'Playwright darf die vollständige Suite nicht durch shard/maxFailures beschränken.',
  );
  requireThat(
    resolve(config.rootDir) === resolve(testDir),
    'Playwright rootDir muss die vollständige E2E-Testsammlung erfassen.',
  );
  requireThat(
    config.projects?.length > 0 && report.tests?.length > 0,
    'Playwright hat keine Projekte/Tests erkannt.',
  );
  for (const project of config.projects) {
    requireThat(
      resolve(project.testDir) === resolve(testDir),
      `Projekt ${project.name}: testDir beschränkt die Suite.`,
    );
    const grep = Array.isArray(project.grep) ? project.grep : [project.grep];
    requireThat(
      grep.length === 1 && grep[0]?.source === '.*' && grep[0].flags === '' && !project.grepInvert,
      `Projekt ${project.name}: grep/grepInvert beschränkt Tests.`,
    );
    const files = new Set(
      report.tests
        .filter((test) => test.project === project.name)
        .map((test) => resolve(test.file)),
    );
    const missing = specs.filter((spec) => !files.has(resolve(spec)));
    requireThat(
      missing.length === 0,
      `Projekt ${project.name}: Specs fehlen in der tatsächlichen Discovery: ${missing.map((spec) => relative(testDir, spec)).join(', ')}`,
    );
  }
  requireThat(
    report.tests.every(
      (test) =>
        test.expectedStatus !== 'skipped' &&
        !test.annotations.some((annotation) => ['skip', 'fixme'].includes(annotation.type)),
    ),
    'Playwright-Discovery enthält übersprungene Tests.',
  );
  return { specs: specs.length, tests: report.tests.length };
}

export function discoverTests(e2eDir, env, cliPath) {
  const cli =
    cliPath ?? createRequire(resolve(e2eDir, 'package.json')).resolve('@playwright/test/cli');
  const result = spawnSync(process.execPath, [cli, 'test', '--list', `--reporter=${REPORTER}`], {
    cwd: e2eDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  requireThat(
    !result.error && result.status === 0,
    `Playwright-Discovery fehlgeschlagen: ${result.error?.message ?? result.stderr ?? ''}\n${result.stdout ?? ''}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Playwright-Discovery lieferte keinen eindeutigen JSON-Bericht.');
  }
}

export function checkParanoidE2e(root = ROOT) {
  const env = checkWorkflow(readFileSync(resolve(root, '.forgejo/workflows/ci.yml'), 'utf8'));
  const e2eDir = resolve(root, 'apps/e2e');
  const testDir = resolve(e2eDir, 'tests');
  const specs = scanTestSources(testDir);
  return checkDiscovery(discoverTests(e2eDir, env), specs, testDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkParanoidE2e();
    console.log(
      `OK: Vollständiger CI-Aufruf, Object-Lock-Checks und Playwright-Discovery (${result.tests} Tests in ${result.specs} Specs). Kein E2E-Ausführungsnachweis.`,
    );
  } catch (error) {
    console.error(
      `FEHLER: ${error.message}\nFix: Vollständige E2E-Ausführung und Testerkennung wiederherstellen; Pflichtnachweise nicht umgehen.`,
    );
    process.exitCode = 1;
  }
}
