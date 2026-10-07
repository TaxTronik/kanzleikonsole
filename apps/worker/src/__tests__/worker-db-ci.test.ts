// Fachkatalog: WORKFLOW-LIFECYCLE-001, TAX-CONTROL-STATUS-001, DOC-UPLOAD-JOURNAL-001
// Die PostgreSQL-Suiten der Worker-Jobs findet der db-Job per Glob
// (scripts/ci/db-suites.mjs, B-02) und führt sie mit DB_TESTS=1 nach den
// Migrationen aus; lokal schaltet WORKER_DB_TEST=1 sie ein. Dieser Test bindet
// die Nachweise an die Suiten und hält das Opt-in aus dem Quality-Job heraus.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Step = { env?: Record<string, string> };
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
};
type Reader = (file: string) => string | null;
interface DbSuites {
  findDbSuites(root: string): string[];
  checkDbSuiteFile(input: { workflow: Workflow; file: string; read: Reader }): string[];
  dbSwitchOutsideDbJob(workflow: Workflow): boolean;
  repositoryReader(root: string): Reader;
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// scripts/ci/db-suites.mjs liegt außerhalb von rootDir: zur Laufzeit laden.
const dbSuites = (await import(
  pathToFileURL(join(ROOT, 'scripts/ci/db-suites.mjs')).href
)) as DbSuites;
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(readFileSync(join(ROOT, '.forgejo/workflows/ci.yml'), 'utf8'));
const read = dbSuites.repositoryReader(ROOT);

const flag = 'WORKER_DB_TEST';
const specs = [
  'apps/worker/src/jobs/__tests__/workflow-n8n-dispatch-db.test.ts',
  'apps/worker/src/jobs/__tests__/reminders-daily-db.test.ts',
  'apps/worker/src/jobs/__tests__/mail-outbox-db.test.ts',
  // K-06: offene Upload-Absichten nach Prozessabbruch werden aufgelöst.
  'apps/worker/src/jobs/__tests__/storage-orphan-cleanup-db.test.ts',
];

describe('Worker-PostgreSQL-Suiten im CI', () => {
  it('laufen per Glob blockierend nach den Migrationen und archivieren ihr Protokoll', () => {
    const found = dbSuites.findDbSuites(ROOT).filter((file) => file.startsWith('apps/worker/'));
    expect(found).toEqual(expect.arrayContaining(specs));
    for (const spec of found) {
      expect(dbSuites.checkDbSuiteFile({ workflow, file: spec, read }), spec).toEqual([]);
    }
  });

  it('bleiben im Quality-Job ohne Datenbank abgeschaltet', () => {
    expect(dbSuites.dbSwitchOutsideDbJob(workflow)).toBe(false);
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs['quality']!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs['quality']!.steps) expect(step.env?.[flag]).toBeUndefined();
    for (const spec of specs) {
      expect(read(spec)).toContain("process.env['WORKER_DB_TEST'] === '1'");
    }
  });
});
