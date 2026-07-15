import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migration034 = readFileSync(
  new URL(
    '../../prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const migration044 = readFileSync(
  new URL(
    '../../prisma/migrations/20260801004400_legacy_gwg_guard_recovery/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

function functionBody(contents: string, declaration: string): string {
  const declarationOffset = contents.indexOf(declaration);
  expect(declarationOffset, `Funktionsdeklaration fehlt: ${declaration}`).toBeGreaterThanOrEqual(0);
  const bodyOffset = contents.indexOf('AS $$', declarationOffset);
  const bodyEnd = contents.indexOf('\n$$;', bodyOffset);
  expect(bodyOffset, `Funktionskörper fehlt: ${declaration}`).toBeGreaterThan(declarationOffset);
  expect(bodyEnd, `Funktionsende fehlt: ${declaration}`).toBeGreaterThan(bodyOffset);
  return contents.slice(bodyOffset + 'AS $$'.length, bodyEnd).replaceAll('\r\n', '\n');
}

describe('GwG Legacy-Guard-Recovery 044', () => {
  it('ist als Ganzes explizit transaktional', () => {
    const statements = migration044
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('--'));
    expect(statements[0]).toBe('BEGIN;');
    expect(statements.at(-1)).toBe('COMMIT;');
  });

  it('stellt alle kanonischen 034-Guard-Trigger idempotent wieder her', () => {
    const triggerNames = [
      'document_gwg_invite_scope_and_claim',
      'gwg_id_document_scope_and_claim',
      'gwg_invite_check_scope_and_claim',
      'client_freeze_gwg_claim',
      'gwg_check_freeze_gwg_claim',
      'gwg_check_verified_legal_snapshot_immutable',
      'gwg_beneficial_owner_verified_snapshot_immutable',
      'gwg_check_no_hard_delete',
      'gwg_check_fail_closed_client',
      'document_version_block_gwg_destruction',
    ];
    for (const triggerName of triggerNames) {
      expect(migration044).toContain(`DROP TRIGGER IF EXISTS ${triggerName}`);
      expect(migration044).toContain(`CREATE TRIGGER ${triggerName}`);
    }
  });

  it('stellt den kanonischen 034-Destroy-Kern wieder her und behaelt den 042-Lock-Wrapper', () => {
    expect(
      functionBody(
        migration044,
        'CREATE OR REPLACE FUNCTION app.destroy_gwg_check_034_recovery(p_check_id UUID)',
      ),
    ).toBe(
      functionBody(
        migration034,
        'CREATE OR REPLACE FUNCTION app.destroy_gwg_check(p_check_id UUID)',
      ),
    );
    expect(migration044).toContain('wrapper_source = canonical_source');
    expect(migration044).toContain('core_source IS DISTINCT FROM canonical_source');
    expect(migration044).toContain(
      'ALTER FUNCTION app.destroy_gwg_check_034_recovery(UUID)\n        RENAME TO destroy_gwg_check_locked_impl;',
    );
    expect(migration044).toContain(
      "'gwg-check-lifecycle:' || check_tenant::TEXT || ':' || check_client::TEXT",
    );
    expect(migration044).toContain('RETURN app.destroy_gwg_check_locked_impl(p_check_id);');
  });

  it('ueberschreibt 034 zuletzt mit den aktuellen 043-Identity-Guards', () => {
    expect(migration044).toContain(
      'CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_subject_and_set()',
    );
    expect(migration044).toContain(
      'CREATE OR REPLACE FUNCTION app.enforce_gwg_identity_assignment_on_verification()',
    );
    expect(migration044).toContain('OLD."destroyed_at" IS NOT NULL');
    expect(migration044).toContain('identity_assignment_required');
    expect(migration044).toContain('member."document_set_id" = gid."document_set_id"');
  });

  it('rollt auch nach bereits gedroppten Triggern bei einem spaeten Fehler vollstaendig zurueck', async () => {
    const client = new Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    try {
      const snapshot = async () => {
        const triggers = await client.query<{ name: string; definition: string }>(`
          SELECT t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
            FROM pg_catalog.pg_trigger t
           WHERE t.tgname IN (
             'document_gwg_invite_scope_and_claim',
             'gwg_id_document_scope_and_claim',
             'gwg_check_no_hard_delete',
             'document_version_block_gwg_destruction'
           )
             AND NOT t.tgisinternal
           ORDER BY t.tgname
        `);
        const core = await client.query<{ source: string }>(`
          SELECT p.prosrc AS source
            FROM pg_catalog.pg_proc p
           WHERE p.oid = 'app.destroy_gwg_check_locked_impl(uuid)'::regprocedure
        `);
        return { triggers: triggers.rows, core: core.rows[0]?.source };
      };

      const before = await snapshot();
      const failingMigration = migration044.replace(
        /\nCOMMIT;\s*$/,
        '\nSELECT 1 / 0; -- absichtlicher spaeter Regressionstest-Fehler\nCOMMIT;\n',
      );
      expect(failingMigration).not.toBe(migration044);

      let failure: unknown;
      try {
        await client.query(failingMigration);
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toMatch(/division by zero/i);
      await client.query('ROLLBACK');
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }, 30_000);
});
