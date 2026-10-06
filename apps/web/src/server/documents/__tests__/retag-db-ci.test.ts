// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// Review-Finding K-03: Die PostgreSQL-Suite des Retag-Service läuft nur mit
// Opt-in im blockierenden db-Job nach den Migrationen.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
  with?: { name?: string; path?: string };
};
type Job = {
  steps: Step[];
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
};
type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> };

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(
  readFileSync(new URL('../../../../../../.forgejo/workflows/ci.yml', import.meta.url), 'utf8'),
);
const flag = 'DOCUMENT_RETAG_DB_TEST';
const spec = 'src/server/documents/__tests__/retag-db.test.ts';
const log = 'testbericht-document-retag.log';

describe('Retag-Service: PostgreSQL-Nachweis im CI', () => {
  it('führt genau die Suite mit Opt-in nach den Migrationen blockierend aus', () => {
    const db = workflow.jobs.db!;
    expect(db.if).toBeUndefined();
    expect(db['continue-on-error']).toBeFalsy();
    const candidates = db.steps.filter((step) => step.run?.includes(spec));
    expect(candidates).toHaveLength(1);
    const step = candidates[0]!;
    expect(step.env?.[flag]).toBe('1');
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeFalsy();
    expect(step.run?.trim()).toBe(
      `set -o pipefail\npnpm --filter @taxtronik/web exec vitest run ${spec} 2>&1 | tee ${log}`,
    );
    const migrationIndex = db.steps.findIndex(
      (item) => item.run?.trim() === 'pnpm db:migrate:deploy',
    );
    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(db.steps.indexOf(step)).toBeGreaterThan(migrationIndex);
  });

  it('lässt das Opt-in in Jobs ohne Datenbank aus', () => {
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs.quality!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs.quality!.steps) expect(step.env?.[flag]).toBeUndefined();
    expect(readFileSync(new URL('./retag-db.test.ts', import.meta.url), 'utf8')).toContain(
      "process.env.DOCUMENT_RETAG_DB_TEST === '1'",
    );
  });

  it('archiviert das Protokoll auch nach einem Fehlschlag', () => {
    const upload = workflow.jobs.db!.steps.find(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'testbericht-db',
    );
    expect(upload).toBeDefined();
    expect(upload!.if).toBe('always()');
    expect(upload!.with?.path?.split(/\r?\n/)).toContain(log);
  });
});
