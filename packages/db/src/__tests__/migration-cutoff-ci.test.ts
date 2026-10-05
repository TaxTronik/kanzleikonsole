// Fachkatalog: GWG-ACTIVATION-GATE-001
// Fachkatalog: GWG-SELF-ONBOARDING-001
//
// Review-Finding B-10: Die Altbestandstests fuer Migration 034 (GwG fail-closed)
// und 041 (Onboarding-Backfill) laufen als SQL-Dateien ueber
// scripts/ci/migration-cutoff.sh und duerfen nicht mehr still vom v*-Tag
// abhaengen. Dieser Test haelt Verdrahtung, Cutoffs und Dateien zusammen.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean };
type Job = { steps: Step[]; if?: string; 'continue-on-error'?: boolean };
type Workflow = { jobs: Record<string, Job> };

const root = new URL('../../../../', import.meta.url);
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(readFileSync(new URL('.forgejo/workflows/ci.yml', root), 'utf8'));
const script = 'scripts/ci/migration-cutoff.sh';
const migrations = readdirSync(new URL('packages/db/prisma/migrations/', root))
  .filter((name) => /^\d{14}_/.test(name))
  .sort();

// Erste Migration nach dem Cutoff = die Migration, deren Altbestandsverhalten
// der jeweilige Fall prueft.
const cases = [
  {
    fixtures: 'scripts/ci/migration-cutoff/gwg-034-fixtures.sql',
    asserts: 'scripts/ci/migration-cutoff/gwg-034-asserts.sql',
    underTest: '20260801003400_gwg_fail_closed_and_destruction',
    rule: 'GWG-ACTIVATION-GATE-001',
  },
  {
    fixtures: 'scripts/ci/migration-cutoff/onboarding-041-fixtures.sql',
    asserts: 'scripts/ci/migration-cutoff/onboarding-041-asserts.sql',
    underTest: '20260801004100_onboarding_gwg_review_workflow',
    rule: 'GWG-SELF-ONBOARDING-001',
  },
];

function cutoffSteps(job: Job): Step[] {
  return job.steps.filter((step) => step.run?.includes(script));
}

describe('Altbestandstests mit Migrations-Cutoff im CI', () => {
  it('laufen im upgrade-path-Job ohne Tag-Bedingung', () => {
    const job = workflow.jobs['upgrade-path']!;
    expect(job.if).toBeUndefined();
    expect(job['continue-on-error']).toBeFalsy();
    const steps = cutoffSteps(job);
    expect(steps).toHaveLength(cases.length);
    for (const step of steps) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeFalsy();
    }
    const client = job.steps.findIndex((step) => step.name === 'Install PostgreSQL client');
    expect(client).toBeGreaterThanOrEqual(0);
    expect(client).toBeLessThan(job.steps.indexOf(steps[0]!));
  });

  it.each(cases)('$underTest: Cutoff direkt davor, SQL-Dateien vorhanden', (testCase) => {
    const step = cutoffSteps(workflow.jobs['upgrade-path']!).find((candidate) =>
      candidate.run?.includes(testCase.fixtures),
    );
    expect(step).toBeDefined();
    const args = step!.run!.replace(/\\\n/g, ' ').trim().split(/\s+/);
    expect(args.slice(0, 2)).toEqual(['bash', script]);
    const [cutoff, fixtures, asserts] = args.slice(2);
    expect(args).toHaveLength(5);
    expect([fixtures, asserts]).toEqual([testCase.fixtures, testCase.asserts]);
    expect(migrations).toContain(cutoff);
    expect(migrations[migrations.indexOf(cutoff!) + 1]).toBe(testCase.underTest);
    for (const file of [script, testCase.fixtures, testCase.asserts]) {
      expect(existsSync(new URL(file, root))).toBe(true);
    }
    const assertSql = readFileSync(new URL(testCase.asserts, root), 'utf8');
    expect(assertSql).toContain(`Fachkatalog: ${testCase.rule}`);
    expect(assertSql).toMatch(/RAISE EXCEPTION/);
  });
});
