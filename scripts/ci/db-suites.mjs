// =============================================================================
// PostgreSQL-Suiten im db-CI-Job (Review-Befund B-02).
//
// Jede Datei `*-db.test.ts(x)` unter `src/` eines Pakets ist eine DB-Suite. Der
// db-Job findet sie je Paket per Glob (`pnpm --filter <paket> run test:db` mit
// vitest.db.config.ts) statt ueber eine gepflegte Dateiliste; die Unit-Laeufe
// (`test`, Quality-Job) schliessen dieselben Dateien aus. Lokal schaltet weiter
// das eigene Flag einer Suite sie ein (z. B. YEAR_END_DB_TEST=1), im db-Job
// DB_TESTS=1 alle. Mit CI=true scheitert eine Suite ohne Opt-in, statt still
// uebersprungen zu werden.
//
// Einzige Quelle fuer die Vitest-Konfigurationen der Pakete und die
// Strukturpruefung (scripts/tests/db-suites-ci.test.mjs, Quality-Job).
// =============================================================================

import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Glob der DB-Suiten relativ zum Paketverzeichnis. */
export const DB_SUITE_GLOB = 'src/**/*-db.test.{ts,tsx}';

/** Ausschluss derselben Dateien in den Unit-Laeufen (`test`-Skript der Pakete). */
export const UNIT_EXCLUDE_ARGUMENT = '--exclude "**/*-db.test.{ts,tsx}"';

/** Opt-in des db-Jobs fuer alle DB-Suiten; lokal gilt zusaetzlich das Flag der Suite. */
export const DB_SUITES_SWITCH = 'DB_TESTS';

/**
 * Pakete mit Glob-Lauf im db-Job. @taxtronik/db fehlt bewusst: dessen ganze
 * Suite ist datenbankgebunden und laeuft im db-Job vollstaendig
 * (`pnpm --filter @taxtronik/db test`); ohne Datenbank scheitert schon ihre
 * Vitest-Konfiguration.
 */
export const DB_SUITE_PACKAGES = [
  { name: '@taxtronik/web', dir: 'apps/web', log: 'testbericht-web-db.log' },
  { name: '@taxtronik/worker', dir: 'apps/worker', log: 'testbericht-worker-db.log' },
  { name: '@taxtronik/evidence', dir: 'packages/evidence', log: 'testbericht-evidence-db.log' },
];

/** Paket, dessen gesamte Suite der db-Job ausfuehrt. */
export const DB_PACKAGE = { name: '@taxtronik/db', dir: 'packages/db', log: 'testbericht-db.log' };

/**
 * Suiten mit eigener Datenbank: nicht im Glob-Lauf ihres Pakets, sondern in
 * genau einem eigenen Schritt des db-Jobs, der diese Datenbank anlegt.
 * Schluessel: Pfad relativ zum Repository; Wert: Begruendung.
 */
export const ISOLATED_DB_SUITES = {
  'apps/web/src/server/mandate-expansion/__tests__/service-db.test.ts':
    'braucht eine frisch migrierte, isolierte Datenbank (taxtronik_expansion_*), die die Suite nicht selbst abraeumt',
};

const posix = (path) => path.split(sep).join('/');

/** Isolierte Suiten eines Pakets relativ zum Paketverzeichnis (Vitest-`exclude`). */
export function isolatedDbSuitesOf(dir) {
  const prefix = `${dir}/`;
  return Object.keys(ISOLATED_DB_SUITES)
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
}

/** Alle DB-Suiten unter apps/* und packages/* (Pfade relativ zum Repository, sortiert). */
export function findDbSuites(root) {
  return globSync(`{apps,packages}/*/${DB_SUITE_GLOB}`, { cwd: root }).map(posix).sort();
}

/** Paketverzeichnis (apps/<x> bzw. packages/<x>) einer Datei. */
export function packageDirOf(file) {
  return file.split('/').slice(0, 2).join('/');
}

const MIGRATION_STEP = 'pnpm db:migrate:deploy';

function stepIndex(steps, predicate) {
  return steps.findIndex((step) => predicate(step));
}

/** Schritte des db-Jobs, deren `run` den Text (bzw. das Muster) enthaelt. */
function stepsRunning(job, pattern) {
  return (job?.steps ?? []).filter((step) =>
    typeof pattern === 'string' ? (step.run ?? '').includes(pattern) : pattern.test(step.run ?? ''),
  );
}

const DB_PACKAGE_RUN = /^pnpm --filter @taxtronik\/db test(?: |$)/m;

/** `run` des Glob-Laufs eines Pakets (mit Protokoll). */
export function globRunOf(pkg) {
  return `set -o pipefail\npnpm --filter ${pkg.name} run test:db 2>&1 | tee ${pkg.log}`;
}

/**
 * Der Schritt des db-Jobs, der `file` ausfuehrt: der Glob-Lauf seines Pakets
 * oder, fuer eine isolierte Suite, deren eigener Schritt. `null`, wenn keiner
 * (oder mehr als einer) passt.
 */
export function dbJobStepFor(workflow, file) {
  const db = workflow?.jobs?.db;
  const dir = packageDirOf(file);
  if (dir === DB_PACKAGE.dir) {
    const steps = stepsRunning(db, DB_PACKAGE_RUN);
    return steps.length === 1 ? steps[0] : null;
  }
  if (file in ISOLATED_DB_SUITES) {
    const steps = stepsRunning(db, file.slice(dir.length + 1));
    return steps.length === 1 ? steps[0] : null;
  }
  const pkg = DB_SUITE_PACKAGES.find((candidate) => candidate.dir === dir);
  if (!pkg) return null;
  const steps = stepsRunning(db, `pnpm --filter ${pkg.name} run test:db`);
  return steps.length === 1 ? steps[0] : null;
}

/** Hochgeladene Testprotokolle des db-Jobs (Artefakt testbericht-db). */
export function uploadedDbLogs(workflow) {
  const upload = (workflow?.jobs?.db?.steps ?? []).find(
    (step) =>
      (step.uses ?? '').startsWith('actions/upload-artifact@') &&
      step.with?.name === 'testbericht-db',
  );
  if (!upload || upload.if !== 'always()') return [];
  return String(upload.with?.path ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const OPT_IN = /process\.env(?:\.DB_TESTS|\['DB_TESTS'\]) === '1'/;
/** Fail-closed-Wache der App- und Paket-Suiten: in CI ohne Opt-in werfen. */
const ENABLED_GUARD = /if \(!enabled && process\.env(?:\.CI|\['CI'\]) === 'true'\)/;
/** @taxtronik/db: ohne Datenbank in CI werfen (Muster rls-resource-uuid-lookup.test.ts). */
const DATABASE_GUARD = /process\.env\['CI'\] === 'true' && !hasDatabase/;

function migrationIndex(workflow) {
  return stepIndex(
    workflow?.jobs?.db?.steps ?? [],
    (step) => (step.run ?? '').trim() === MIGRATION_STEP,
  );
}

/**
 * Prueft eine DB-Suite: Wache in der Datei und genau ein Schritt des db-Jobs,
 * der sie nach den Migrationen ohne Bedingung ausfuehrt und protokolliert.
 * `read(pfad)` liefert Dateiinhalte relativ zum Repository.
 */
export function checkDbSuiteFile({ workflow, file, read }) {
  const problems = [];
  const dir = packageDirOf(file);
  const known = [...DB_SUITE_PACKAGES.map((pkg) => pkg.dir), DB_PACKAGE.dir];
  if (!known.includes(dir)) {
    return [
      `${file}: Paket ${dir} hat keinen Glob-Lauf im db-Job (DB_SUITE_PACKAGES in scripts/ci/db-suites.mjs)`,
    ];
  }
  const source = read(file) ?? '';
  if (dir === DB_PACKAGE.dir) {
    if (!DATABASE_GUARD.test(source)) {
      problems.push(`${file}: scheitert in CI ohne Datenbank nicht (hasDatabase-Wache)`);
    }
  } else {
    if (!ENABLED_GUARD.test(source)) {
      problems.push(
        `${file}: scheitert in CI ohne Opt-in nicht (if (!enabled && process.env['CI'] === 'true'))`,
      );
    }
    if (!OPT_IN.test(source)) {
      problems.push(`${file}: wird nicht per ${DB_SUITES_SWITCH}=1 eingeschaltet`);
    }
  }
  const step = dbJobStepFor(workflow, file);
  if (!step) {
    problems.push(`${file}: kein (eindeutiger) Schritt im db-Job fuehrt die Suite aus`);
    return problems;
  }
  if (step.if !== undefined || step['continue-on-error']) {
    problems.push(`${file}: Schritt "${step.name}" ist bedingt oder continue-on-error`);
  }
  if (workflow.jobs.db.steps.indexOf(step) < migrationIndex(workflow)) {
    problems.push(`${file}: Schritt "${step.name}" laeuft vor den Migrationen`);
  }
  const log = /\| tee (\S+)\s*$/m.exec(step.run ?? '')?.[1];
  if (!/^set -euo pipefail$|^set -o pipefail$/m.test(step.run ?? '') || !log) {
    problems.push(`${file}: Schritt "${step.name}" protokolliert nicht mit pipefail und tee`);
  } else if (!uploadedDbLogs(workflow).includes(log)) {
    problems.push(`${file}: Protokoll ${log} fehlt im Artefakt testbericht-db`);
  }
  const glob = !(file in ISOLATED_DB_SUITES) && dir !== DB_PACKAGE.dir;
  if (glob && step.env?.[DB_SUITES_SWITCH] !== '1') {
    problems.push(`${file}: Glob-Schritt "${step.name}" setzt ${DB_SUITES_SWITCH}=1 nicht`);
  }
  return problems;
}

/** Ob der Quality-Job (oder der ganze Workflow) DB-Suiten einschaltet. */
export function dbSwitchOutsideDbJob(workflow) {
  const quality = workflow?.jobs?.quality;
  return [
    workflow?.env?.[DB_SUITES_SWITCH],
    quality?.env?.[DB_SUITES_SWITCH],
    ...(quality?.steps ?? []).map((step) => step.env?.[DB_SUITES_SWITCH]),
  ].some((value) => value !== undefined);
}

/**
 * Prueft die Verdrahtung aller DB-Suiten (`files`, z. B. aus findDbSuites) im
 * geparsten Workflow: je Datei checkDbSuiteFile, dazu Job, Glob-Schritte,
 * Artefakt und isolierte Suiten. Rueckgabe: Befunde (leer = in Ordnung).
 */
export function checkDbSuiteWiring({ workflow, files, read }) {
  const problems = [];
  const db = workflow?.jobs?.db;
  if (!db) return ['ci.yml: Job db fehlt'];
  if (db.if !== undefined || db['continue-on-error']) {
    problems.push('ci.yml: Job db darf weder bedingt noch continue-on-error sein');
  }
  if (migrationIndex(workflow) < 0) {
    problems.push(`ci.yml: db-Job ohne Schritt "${MIGRATION_STEP}"`);
  }
  if (uploadedDbLogs(workflow).length === 0) {
    problems.push('ci.yml: db-Job laedt testbericht-db nicht mit if: always() hoch');
  }
  if (dbSwitchOutsideDbJob(workflow)) {
    problems.push(`ci.yml: ${DB_SUITES_SWITCH} gehoert nur in den db-Job, nicht in Quality`);
  }
  for (const file of files) problems.push(...checkDbSuiteFile({ workflow, file, read }));
  for (const isolated of Object.keys(ISOLATED_DB_SUITES)) {
    if (!files.includes(isolated)) {
      problems.push(
        `${isolated}: isolierte Suite existiert nicht (mehr) oder passt nicht zum Glob`,
      );
    }
  }
  for (const pkg of DB_SUITE_PACKAGES) {
    if (!files.some((file) => packageDirOf(file) === pkg.dir)) {
      problems.push(`${pkg.dir}: keine DB-Suite mehr, Eintrag in DB_SUITE_PACKAGES entfernen`);
    }
    const steps = stepsRunning(db, `pnpm --filter ${pkg.name} run test:db`);
    if (steps.length !== 1 || steps[0].run?.trim() !== globRunOf(pkg)) {
      problems.push(`ci.yml: db-Job braucht genau einen Schritt "${globRunOf(pkg)}"`);
    }
  }
  return problems;
}

/**
 * Prueft die Paket-Skripte und Vitest-Konfigurationen des Glob-Laufs.
 * `read(pfad)` liefert Dateiinhalte relativ zum Repository oder `null`.
 */
export function checkDbSuitePackages({ read }) {
  const problems = [];
  for (const pkg of DB_SUITE_PACKAGES) {
    const scripts = JSON.parse(read(`${pkg.dir}/package.json`) ?? '{}').scripts ?? {};
    if (scripts.test !== `vitest run ${UNIT_EXCLUDE_ARGUMENT}`) {
      problems.push(`${pkg.dir}: "test" muss "vitest run ${UNIT_EXCLUDE_ARGUMENT}" sein`);
    }
    if (scripts['test:db'] !== 'vitest run --config vitest.db.config.ts') {
      problems.push(`${pkg.dir}: "test:db" muss "vitest run --config vitest.db.config.ts" sein`);
    }
    const config = read(`${pkg.dir}/vitest.db.config.ts`);
    if (config === null) {
      problems.push(`${pkg.dir}: vitest.db.config.ts fehlt`);
      continue;
    }
    for (const fragment of [
      "from '../../scripts/ci/db-suites.mjs'",
      'include: [DB_SUITE_GLOB]',
      `isolatedDbSuitesOf('${pkg.dir}')`,
      'fileParallelism: false',
    ]) {
      if (!config.includes(fragment)) {
        problems.push(`${pkg.dir}/vitest.db.config.ts: "${fragment}" fehlt`);
      }
    }
  }
  const dbScripts = JSON.parse(read(`${DB_PACKAGE.dir}/package.json`) ?? '{}').scripts ?? {};
  if (/--exclude/.test(dbScripts.test ?? '')) {
    problems.push(`${DB_PACKAGE.dir}: "test" darf keine DB-Suiten ausschliessen`);
  }
  return problems;
}

/** Dateileser relativ zum Repository (`null`, wenn die Datei fehlt). */
export function repositoryReader(root) {
  return (file) => {
    const path = join(root, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
}
