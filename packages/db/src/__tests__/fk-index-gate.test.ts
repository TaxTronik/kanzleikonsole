// Fachkatalog: INV-STORNO-REFERENCE-001
// Fachkatalog: INV-TIME-ENTRY-CLAIM-001
// Fachkatalog: WORKFLOW-DEPENDENCY-001
//
// Review-Finding D-05: Gate „FK ohne führenden Index“ (pnpm verify:fk-indexes).
// Regel, Allowlist, CI-Verdrahtung und der Stand der migrierten Datenbank.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { afterAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import {
  ACTOR_REFERENCES,
  FOREIGN_KEYS_SQL,
  INDEXES_SQL,
  KNOWN_UNINDEXED,
  TENANT_REFERENCES,
  checkForeignKeyIndexes,
  foreignKeyId,
  indexCoversForeignKey,
  type ForeignKeyInfo,
  type IndexInfo,
} from '../../scripts/fk-index-coverage';

type Step = { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean };
type Job = { steps: Step[]; if?: string; 'continue-on-error'?: boolean };
type Workflow = { jobs: Record<string, Job> };

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => Workflow };
const workflow = yaml.load(
  readFileSync(new URL('../../../../.forgejo/workflows/ci.yml', import.meta.url), 'utf8'),
);
const rootPackage = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };
const dbPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('FK-Index-Regel', () => {
  it('erkennt führende FK-Spalten, auch hinter tenant_id', () => {
    expect(indexCoversForeignKey(['invoice_id'], ['invoice_id'])).toBe(true);
    expect(indexCoversForeignKey(['client_id'], ['tenant_id', 'client_id', 'created_at'])).toBe(
      true,
    );
    // Teilmenge eines zusammengesetzten FK mit einer Nicht-Tenant-Spalte genügt.
    expect(
      indexCoversForeignKey(['tenant_id', 'client_id', 'thread_id'], ['thread_id', 'created_at']),
    ).toBe(true);
    expect(indexCoversForeignKey(['tenant_id'], ['tenant_id', 'status'])).toBe(true);
  });

  it('verwirft Indizes, deren führende Spalten nicht zum FK gehören', () => {
    expect(
      indexCoversForeignKey(['invoice_id'], ['tenant_id', 'client_id', 'billable', 'invoice_id']),
    ).toBe(false);
    expect(
      indexCoversForeignKey(['successor_item_id'], ['predecessor_item_id', 'successor_item_id']),
    ).toBe(false);
    expect(indexCoversForeignKey(['tenant_id', 'snapshot_id'], ['tenant_id'])).toBe(false);
    expect(indexCoversForeignKey(['tenant_id'], ['client_id', 'tenant_id'])).toBe(false);
  });

  it('meldet neue FK ohne Index und verwaiste Allowlist-Einträge', () => {
    const fks: ForeignKeyInfo[] = [
      { table: 'a', columns: ['x_id'], references: 'x', constraint: 'a_x_fkey' },
      { table: 'a', columns: ['created_by'], references: 'staff_user', constraint: 'a_by_fkey' },
      { table: 'b', columns: ['y_id'], references: 'y', constraint: 'b_y_fkey' },
    ];
    const indexes: IndexInfo[] = [{ table: 'b', columns: ['tenant_id', 'y_id'] }];
    expect(checkForeignKeyIndexes(fks, indexes, ['a.created_by', 'b.y_id'])).toEqual({
      violations: [fks[0]],
      stale: ['b.y_id'],
      checked: 3,
      allowlisted: 1,
    });
  });

  it('führt jede Ausnahme genau einmal und sortiert', () => {
    const all = [...ACTOR_REFERENCES, ...TENANT_REFERENCES, ...KNOWN_UNINDEXED];
    expect(new Set(all).size).toBe(all.length);
    for (const list of [ACTOR_REFERENCES, TENANT_REFERENCES, KNOWN_UNINDEXED]) {
      expect([...list]).toEqual([...list].sort());
    }
    expect(TENANT_REFERENCES.every((id) => id.endsWith('.tenant_id'))).toBe(true);
    // Die drei praktisch relevanten FK aus D-05 sind indiziert, nicht ausgenommen.
    for (const id of [
      'time_entry.invoice_id',
      'workflow_dependency.successor_item_id',
      'tax_notice.filing_id',
    ]) {
      expect(all).not.toContain(id);
    }
  });
});

describe('FK-Index-Gate im CI', () => {
  it('läuft als blockierender Schritt direkt nach dem RLS-Gate', () => {
    const db = workflow.jobs['db']!;
    expect(db.if).toBeUndefined();
    expect(db['continue-on-error']).toBeFalsy();
    const gates = db.steps.filter((step) => step.run?.trim() === 'pnpm verify:fk-indexes');
    expect(gates).toHaveLength(1);
    const gate = gates[0]!;
    expect(gate.if).toBeUndefined();
    expect(gate['continue-on-error']).toBeFalsy();
    const rls = db.steps.findIndex((step) => step.run?.trim() === 'pnpm verify:rls');
    const migrated = db.steps.findIndex((step) => step.run?.trim() === 'pnpm db:migrate:deploy');
    expect(migrated).toBeGreaterThanOrEqual(0);
    expect(rls).toBeGreaterThan(migrated);
    expect(db.steps.indexOf(gate)).toBe(rls + 1);
  });

  it('startet das Paketskript über die Workspace-Wurzel', () => {
    expect(rootPackage.scripts['verify:fk-indexes']).toBe(
      'pnpm --filter @taxtronik/db verify:fk-indexes',
    );
    expect(dbPackage.scripts['verify:fk-indexes']).toBe(
      'tsx --env-file-if-exists=../../.env scripts/verify-fk-indexes.ts',
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('FK-Index-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

afterAll(async () => {
  await owner.$disconnect();
});

describeWithDatabase('FK-Index-Gate: migrierte Datenbank', () => {
  it('hat keinen FK ohne führenden Index außerhalb der Allowlist und keine verwaiste Ausnahme', async () => {
    const foreignKeys = await owner.$queryRawUnsafe<ForeignKeyInfo[]>(FOREIGN_KEYS_SQL);
    const indexes = await owner.$queryRawUnsafe<IndexInfo[]>(INDEXES_SQL);
    const report = checkForeignKeyIndexes(foreignKeys, indexes);
    expect(report.violations.map(foreignKeyId)).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.checked).toBeGreaterThan(300);
  });

  it('indiziert die drei FK aus D-05 einspaltig', async () => {
    const rows = await owner.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('time_entry_invoice_id_idx', 'workflow_dependency_successor_item_id_idx',
                           'tax_notice_filing_id_idx')
       ORDER BY indexname
    `;
    expect(rows.map((row) => row.indexdef)).toEqual([
      'CREATE INDEX tax_notice_filing_id_idx ON public.tax_notice USING btree (filing_id)',
      'CREATE INDEX time_entry_invoice_id_idx ON public.time_entry USING btree (invoice_id)',
      'CREATE INDEX workflow_dependency_successor_item_id_idx ON public.workflow_dependency USING btree (successor_item_id)',
    ]);
  });
});
