// Review-Finding D-01: kanonische SQL-Quellen gegen eine frisch migrierte Datenbank.
// Dump → Check ist sauber und deterministisch, unabhängig von den
// Sitzungseinstellungen des Aufrufers. Der Rundlauf „Quelldatei ändern →
// Migrationsgerüst → anwenden → Dump“ ergibt genau die geänderten Dateien; er
// läuft in einer Transaktion, die zurückgerollt wird.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  compareSqlSources,
  readDatabaseSources,
  readRepositorySources,
  renderMigration,
  sortedSources,
  writeSqlSources,
  type CanonicalChange,
  type SqlSources,
} from '../../scripts/sql-sources';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Test der kanonischen SQL-Quellen braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const NO_DRIFT = { changed: [], missing: [], unexpected: [], unnormalized: [] };
const FUNCTION_PATH = 'functions/app.tax_notice_set_appeal_deadline().sql';
const TRIGGER_PATH = 'triggers/tax_notice.tax_notice_appeal_deadline_trigger.sql';
const RENAMED_TRIGGER_PATH = 'triggers/tax_notice.tax_notice_appeal_deadline_trigger_d01.sql';
const POLICY_PATH = 'policies/absence.absence_isolation.sql';

function required(sources: SqlSources, path: string): string {
  const content = sources.get(path);
  if (content === undefined) throw new Error(`Quelle fehlt: ${path}`);
  return content;
}

function replaced(content: string, search: string, replacement: string): string {
  expect(content).toContain(search);
  return content.replace(search, replacement);
}

describeWithDatabase('Kanonische SQL-Quellen gegen PostgreSQL', () => {
  const client = new Client({ connectionString: process.env['DATABASE_URL'] });
  let baseline: SqlSources;

  beforeAll(async () => {
    await client.connect();
    baseline = await readDatabaseSources(client);
  });

  afterAll(async () => {
    await client.end();
  });

  it('schreibt einen deterministischen Dump, gegen den die Prüfung sauber ist', async () => {
    expect([...(await readDatabaseSources(client))]).toEqual([...baseline]);
    const root = mkdtempSync(join(tmpdir(), 'tt-sql-sources-'));
    try {
      expect(writeSqlSources(root, baseline)).toEqual({
        written: baseline.size,
        removed: 0,
        unchanged: 0,
      });
      expect(compareSqlSources(baseline, readRepositorySources(root))).toEqual(NO_DRIFT);
      expect(writeSqlSources(root, baseline)).toEqual({
        written: 0,
        removed: 0,
        unchanged: baseline.size,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(baseline.has(FUNCTION_PATH)).toBe(true);
    expect(baseline.has(TRIGGER_PATH)).toBe(true);
    expect(baseline.has(POLICY_PATH)).toBe(true);
  });

  it('hängt nicht von search_path, Datums- oder Zeitzoneneinstellung des Aufrufers ab', async () => {
    const other = new Client({
      connectionString: process.env['DATABASE_URL'],
      options: '-c search_path=public,app -c DateStyle=SQL,DMY -c TimeZone=Europe/Berlin',
    });
    await other.connect();
    try {
      expect(compareSqlSources(baseline, await readDatabaseSources(other))).toEqual(NO_DRIFT);
    } finally {
      await other.end();
    }
  });

  it('übernimmt eine geänderte Quelldatei über das Migrationsgerüst unverändert', async () => {
    const functionBefore = required(baseline, FUNCTION_PATH);
    const triggerBefore = required(baseline, TRIGGER_PATH);
    const policyBefore = required(baseline, POLICY_PATH);
    const functionAfter = replaced(
      functionBefore,
      '\nBEGIN\n',
      '\nBEGIN\n  -- Rundlauf D-01: kanonische Quelle → Migration → Dump\n',
    );
    const renamedTrigger = replaced(
      triggerBefore,
      'CREATE TRIGGER tax_notice_appeal_deadline_trigger ',
      'CREATE TRIGGER tax_notice_appeal_deadline_trigger_d01 ',
    );
    const policyAfter = replaced(policyBefore, '  AS PERMISSIVE\n', '  AS RESTRICTIVE\n');
    const changes: CanonicalChange[] = [
      { path: FUNCTION_PATH, before: functionBefore, after: functionAfter },
      { path: TRIGGER_PATH, before: triggerBefore, after: null },
      { path: RENAMED_TRIGGER_PATH, before: null, after: renamedTrigger },
      { path: POLICY_PATH, before: policyBefore, after: policyAfter },
    ];
    const migration = renderMigration(changes, { ruleIds: ['TAX-NOTICE-APPEAL-001'] });
    const body = migration.slice(
      migration.indexOf('\nBEGIN;\n') + '\nBEGIN;\n'.length,
      migration.lastIndexOf('\nCOMMIT;'),
    );

    const expected = new Map(baseline);
    expected.set(FUNCTION_PATH, functionAfter);
    expected.delete(TRIGGER_PATH);
    expected.set(RENAMED_TRIGGER_PATH, renamedTrigger);
    expected.set(POLICY_PATH, policyAfter);

    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(body);
      const migrated = await readDatabaseSources(client);
      expect(compareSqlSources(migrated, sortedSources(expected))).toEqual(NO_DRIFT);
    } finally {
      await client.query('ROLLBACK');
    }
    expect(compareSqlSources(await readDatabaseSources(client), baseline)).toEqual(NO_DRIFT);
  });
});
