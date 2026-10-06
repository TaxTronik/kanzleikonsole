// Fachkatalog: WORKFLOW-LIFECYCLE-001, TAX-CONTROL-STATUS-001
// Die PostgreSQL-Suiten der Worker-Jobs sind nur mit ausdrücklichem Opt-in
// aktiv (WORKER_DB_TEST=1). Dieser Test stellt sicher, dass der blockierende
// db-Job sie nach den Migrationen ausführt und der Quality-Job sie nicht
// versehentlich ohne Datenbank einschaltet (Muster wie evidence-db-ci.test.ts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Step = {
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
  with?: { name?: string; path?: string };
};
type Job = { steps: Step[]; env?: Record<string, string>; if?: string };
type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> };

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(
  readFileSync(new URL('../../../../.forgejo/workflows/ci.yml', import.meta.url), 'utf8'),
);
const flag = 'WORKER_DB_TEST';
const specs = [
  'src/jobs/__tests__/workflow-n8n-dispatch-db.test.ts',
  'src/jobs/__tests__/reminders-daily-db.test.ts',
  'src/jobs/__tests__/mail-outbox-db.test.ts',
];
const log = 'testbericht-worker-db.log';

describe('Worker-PostgreSQL-Suiten im CI', () => {
  it('laufen mit Opt-in im blockierenden db-Job nach den Migrationen', () => {
    const db = workflow.jobs['db']!;
    const steps = db.steps.filter((step) => specs.some((spec) => step.run?.includes(spec)));
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.env?.[flag]).toBe('1');
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeFalsy();
    expect(step.run?.trim()).toBe(
      'set -o pipefail\n' +
        `pnpm --filter @taxtronik/worker exec vitest run ${specs.join(' ')} 2>&1 | tee ${log}`,
    );
    const migrated = db.steps.findIndex((item) => item.run?.trim() === 'pnpm db:migrate:deploy');
    expect(migrated).toBeGreaterThanOrEqual(0);
    expect(db.steps.indexOf(step)).toBeGreaterThan(migrated);
  });

  it('bleiben im Quality-Job ohne Datenbank abgeschaltet und archivieren das Protokoll', () => {
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs['quality']!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs['quality']!.steps) expect(step.env?.[flag]).toBeUndefined();
    for (const spec of specs) {
      expect(readFileSync(new URL(`../../${spec}`, import.meta.url), 'utf8')).toContain(
        "process.env['WORKER_DB_TEST'] === '1'",
      );
    }

    const upload = workflow.jobs['db']!.steps.find(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'testbericht-db',
    );
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path?.split(/\r?\n/)).toContain(log);
  });
});
