// Fachkatalog: ACCESS-CLIENT-MODE-001
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
const flag = 'INVOICE_SELECTION_DB_TEST';
const spec = 'src/server/auth/__tests__/invoice-selection-db.test.tsx';
const log = 'testbericht-invoice-selection.log';

describe('required invoice selection database evidence in CI', () => {
  it('runs the exact opted-in spec after migrations as a blocking database step', () => {
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

  it('keeps the opt-in out of quality jobs without a database', () => {
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs.quality!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs.quality!.steps) expect(step.env?.[flag]).toBeUndefined();
  });

  it('uploads the database log even after a failed test', () => {
    const upload = workflow.jobs.db!.steps.find(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'testbericht-db',
    );
    expect(upload).toBeDefined();
    expect(upload!.if).toBe('always()');
    expect(upload!.with?.path?.split(/\r?\n/)).toContain(log);
  });
});
