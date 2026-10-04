// Fachkatalog: GWG-ACTIVATION-GATE-001
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// Fachkatalog: GWG-SELF-ONBOARDING-001
//
// Die versionierten GwG-Invarianten entscheiden beim Kunden-Deploy, ob
// schreibende Dienste starten (scripts/ops-lib.sh). Dieser Test haelt ihre
// Pruefung gegen die echte Datenbank im CI: im blockierenden db-Job nach
// migrate deploy und im upgrade-path-Job nach dem Kunden-Update.
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
};
type Job = {
  steps: Step[];
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
};
type Workflow = { jobs: Record<string, Job> };

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(
  readFileSync(new URL('../../../../.forgejo/workflows/ci.yml', import.meta.url), 'utf8'),
);
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };
const command = 'pnpm --filter @taxtronik/db verify:invariants';

function invariantStep(job: Job): Step {
  const steps = job.steps.filter((step) => step.run?.trim() === command);
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

describe('GwG-DB-Invarianten im CI', () => {
  it('startet den versionierten Pruefer ueber das Paketskript', () => {
    expect(packageJson.scripts['verify:invariants']).toBe(
      'node --env-file-if-exists=../../.env scripts/check-db-invariants.mjs',
    );
  });

  it('prueft im blockierenden db-Job direkt nach migrate deploy die echte DB', () => {
    const db = workflow.jobs['db']!;
    expect(db.if).toBeUndefined();
    expect(db['continue-on-error']).toBeFalsy();
    expect(db.env?.['DATABASE_URL']).toMatch(/^postgresql:\/\//);
    const step = invariantStep(db);
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeFalsy();
    expect(step.env?.['DATABASE_URL']).toBeUndefined();
    const migrated = db.steps.findIndex((item) => item.run?.trim() === 'pnpm db:migrate:deploy');
    const ledger = db.steps.findIndex(
      (item) => item.run?.trim() === 'pnpm verify:migration-ledger',
    );
    const dbTests = db.steps.findIndex((item) =>
      item.run?.includes('pnpm --filter @taxtronik/db test'),
    );
    expect(migrated).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeGreaterThan(migrated);
    expect(db.steps.indexOf(step)).toBe(ledger + 1);
    expect(dbTests).toBeGreaterThan(db.steps.indexOf(step));
  });

  it('prueft im upgrade-path-Job die Datenbank nach dem Kunden-Update', () => {
    const upgrade = workflow.jobs['upgrade-path']!;
    expect(upgrade['continue-on-error']).toBeFalsy();
    expect(upgrade.env?.['DATABASE_URL']).toMatch(/^postgresql:\/\//);
    const step = invariantStep(upgrade);
    // Wie jeder Schritt des Jobs nur ohne Release-Tag uebersprungen.
    expect(step.if).toBe("steps.last.outputs.tag != ''");
    expect(step['continue-on-error']).toBeFalsy();
    expect(step.env?.['DATABASE_URL']).toBeUndefined();
    const updated = upgrade.steps.findIndex(
      (item) =>
        item.name?.includes('Kunden-Update') &&
        item.run?.trim() === 'pnpm --filter @taxtronik/db exec prisma migrate deploy',
    );
    expect(updated).toBeGreaterThanOrEqual(0);
    expect(upgrade.steps.indexOf(step)).toBe(updated + 1);
  });
});
