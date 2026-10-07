// Fachkatalog: AUDIT-VERIFY-ALERT-001, AUDIT-RFC3161-ANCHOR-001
// Die PostgreSQL-Suiten der checkpointgestützten Kettenprüfung (P-04) und des
// Rolling-Anchor-Takts (P-05) findet der db-Job per Glob (scripts/ci/db-suites.mjs,
// B-02) und führt sie mit DB_TESTS=1 nach den Migrationen aus; lokal schaltet
// EVIDENCE_DB_TEST=1 sie ein. Dieser Test stellt sicher, dass beide blockierend
// laufen und der Quality-Job sie nicht ohne Datenbank einschaltet.
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

const flag = 'EVIDENCE_DB_TEST';
const specs = [
  'packages/evidence/src/__tests__/verify-checkpoint-db.test.ts',
  'packages/evidence/src/__tests__/anchor-schedule-db.test.ts',
];

describe('Evidence-PostgreSQL-Suiten im CI', () => {
  it('laufen per Glob blockierend nach den Migrationen und archivieren ihr Protokoll', () => {
    expect(dbSuites.findDbSuites(ROOT)).toEqual(expect.arrayContaining(specs));
    for (const spec of specs) {
      expect(dbSuites.checkDbSuiteFile({ workflow, file: spec, read }), spec).toEqual([]);
    }
  });

  it('bleiben im Quality-Job ohne Datenbank abgeschaltet', () => {
    expect(dbSuites.dbSwitchOutsideDbJob(workflow)).toBe(false);
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs['quality']!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs['quality']!.steps) expect(step.env?.[flag]).toBeUndefined();
    for (const spec of specs) {
      expect(read(spec)).toContain("process.env['EVIDENCE_DB_TEST'] === '1'");
    }
  });
});
