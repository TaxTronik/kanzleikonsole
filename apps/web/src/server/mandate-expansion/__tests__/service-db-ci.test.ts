// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001
// Fachkatalog: GWG-RISK-REVIEW-001
// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
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
const flag = 'MANDATE_SERVICE_DB_TEST';
const spec = 'src/server/mandate-expansion/__tests__/service-db.test.ts';
const log = 'testbericht-mandate-services.log';

function serviceStep(): Step {
  const candidates = workflow.jobs.db!.steps.filter((step) => step.run?.includes(spec));
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}

describe('required mandate service evidence in CI', () => {
  it('runs the opted-in suite against a fresh isolated database in the blocking DB job', () => {
    const db = workflow.jobs.db!;
    expect(db.if).toBeUndefined();
    expect(db['continue-on-error']).toBeFalsy();
    const step = serviceStep();
    expect(step.env?.[flag]).toBe('1');
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeFalsy();
    // The suite refuses every database without taxtronik_expansion_ in its name.
    for (const name of ['EXPANSION_DATABASE_URL', 'EXPANSION_DATABASE_APP_URL']) {
      expect(new URL(step.env?.[name] ?? 'invalid:').pathname).toMatch(/^\/taxtronik_expansion_/);
    }
    const run = step.run ?? '';
    expect(run).toMatch(/^set -euo pipefail$/m);
    expect(run).toContain('trap cleanup_expansion_database EXIT');
    const order = [
      "-c 'CREATE DATABASE taxtronik_expansion_ci'",
      'packages/db/prisma/init/01_bootstrap.sql',
      'export DATABASE_URL="$EXPANSION_DATABASE_URL"',
      'export DATABASE_APP_URL="$EXPANSION_DATABASE_APP_URL"',
      'pnpm --filter @taxtronik/db exec prisma migrate deploy',
      `pnpm --filter @taxtronik/web exec vitest run ${spec} 2>&1 | tee ${log}`,
    ].map((fragment) => run.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Der Prisma-Client entsteht im gemeinsamen Job-Setup (Phase `prisma`).
    const generated = db.steps.findIndex((item) =>
      /^bash scripts\/ci\/setup\.sh(?: [a-z-]+)* prisma(?: |$)/.test(item.run?.trim() ?? ''),
    );
    expect(generated).toBeGreaterThanOrEqual(0);
    expect(db.steps.indexOf(step)).toBeGreaterThan(generated);
    expect(
      readFileSync(new URL('../../../../../../scripts/ci/setup.sh', import.meta.url), 'utf8'),
    ).toContain('pnpm --filter @taxtronik/db exec prisma generate');
  });

  it('does not activate database work in the ordinary quality job', () => {
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs.quality!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs.quality!.steps) expect(step.env?.[flag]).toBeUndefined();
    expect(readFileSync(new URL('./service-db.test.ts', import.meta.url), 'utf8')).toContain(
      "process.env['MANDATE_SERVICE_DB_TEST'] === '1'",
    );
  });

  it('retains the service log even if the suite fails', () => {
    const steps = workflow.jobs.db!.steps;
    const upload = steps.find(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'testbericht-db',
    );
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path?.split(/\r?\n/)).toContain(log);
    expect(steps.indexOf(upload!)).toBeGreaterThan(steps.indexOf(serviceStep()));
  });
});
