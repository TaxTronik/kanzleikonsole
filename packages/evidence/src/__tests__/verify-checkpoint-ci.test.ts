// Fachkatalog: AUDIT-VERIFY-ALERT-001
// Die PostgreSQL-Suite der checkpointgestützten Kettenprüfung (P-04) ist nur mit
// ausdrücklichem Opt-in aktiv. Dieser Test stellt sicher, dass der blockierende
// db-Job sie nach den Migrationen ausführt und der Quality-Job sie nicht
// versehentlich ohne Datenbank einschaltet.
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
const flag = 'EVIDENCE_DB_TEST';
const spec = 'src/__tests__/verify-checkpoint-db.test.ts';
const log = 'testbericht-evidence-checkpoints.log';

describe('Prüf-Checkpoint-Suite im CI', () => {
  it('läuft mit Opt-in im blockierenden db-Job nach den Migrationen', () => {
    const db = workflow.jobs['db']!;
    expect(db.if).toBeUndefined();
    const steps = db.steps.filter((step) => step.run?.includes(spec));
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.env?.[flag]).toBe('1');
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeFalsy();
    expect(step.run?.trim()).toBe(
      `set -o pipefail\npnpm --filter @taxtronik/evidence exec vitest run ${spec} 2>&1 | tee ${log}`,
    );
    const migrated = db.steps.findIndex((item) => item.run?.trim() === 'pnpm db:migrate:deploy');
    expect(migrated).toBeGreaterThanOrEqual(0);
    expect(db.steps.indexOf(step)).toBeGreaterThan(migrated);
  });

  it('bleibt im Quality-Job ohne Datenbank abgeschaltet und archiviert das Protokoll', () => {
    expect(workflow.env?.[flag]).toBeUndefined();
    expect(workflow.jobs['quality']!.env?.[flag]).toBeUndefined();
    for (const step of workflow.jobs['quality']!.steps) expect(step.env?.[flag]).toBeUndefined();
    expect(
      readFileSync(new URL('./verify-checkpoint-db.test.ts', import.meta.url), 'utf8'),
    ).toContain("process.env['EVIDENCE_DB_TEST'] === '1'");

    const upload = workflow.jobs['db']!.steps.find(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'testbericht-db',
    );
    expect(upload?.if).toBe('always()');
    expect(upload?.with?.path?.split(/\r?\n/)).toContain(log);
  });
});
