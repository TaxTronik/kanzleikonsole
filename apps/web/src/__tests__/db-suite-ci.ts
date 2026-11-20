// =============================================================================
// CI-Nachweis einer einzelnen PostgreSQL-Suite (Review-Befund B-02).
//
// Der db-Job findet alle `*-db.test.ts(x)` je Paket per Glob
// (scripts/ci/db-suites.mjs, geprüft in scripts/tests/db-suites-ci.test.mjs).
// Die Tests je Suite binden ihren Fachkatalog-Nachweis an genau diese Datei:
// Sie läuft blockierend nach den Migrationen, ihr Protokoll wird auch nach
// einem Fehlschlag archiviert, und ohne Datenbank bleibt sie abgeschaltet.
// =============================================================================

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDbSuiteFile,
  dbJobStepFor,
  dbSwitchOutsideDbJob,
  repositoryReader,
} from '../../../../scripts/ci/db-suites.mjs';

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
};

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(readFileSync(join(ROOT, '.forgejo/workflows/ci.yml'), 'utf8'));
const read = repositoryReader(ROOT);

/**
 * Prüft, dass der db-Job die Suite `spec` (Pfad relativ zum Repository)
 * ausführt und dass ihr lokales Flag `flag` in keinem anderen Job gesetzt ist.
 */
export function describeDbSuiteInCi(title: string, spec: string, flag: string): void {
  describe(title, () => {
    it('läuft blockierend nach den Migrationen im db-Job und archiviert ihr Protokoll', () => {
      expect(checkDbSuiteFile({ workflow, file: spec, read })).toEqual([]);
      expect(dbJobStepFor(workflow, spec)).not.toBeNull();
    });

    it('bleibt außerhalb des db-Jobs (u. a. im Unit-Job) ohne Datenbank abgeschaltet', () => {
      expect(dbSwitchOutsideDbJob(workflow)).toBe(false);
      expect(workflow.env?.[flag]).toBeUndefined();
      expect(workflow.jobs['unit-tests']).toBeDefined();
      for (const [id, job] of Object.entries(workflow.jobs)) {
        if (id === 'db') continue;
        expect(job.env?.[flag], id).toBeUndefined();
        for (const step of job.steps) expect(step.env?.[flag], id).toBeUndefined();
      }
      // Lokal schaltet weiter das eigene Flag die Suite ein.
      expect(read(spec)).toMatch(new RegExp(`process\\.env(?:\\.${flag}|\\['${flag}'\\]) === '1'`));
    });
  });
}
