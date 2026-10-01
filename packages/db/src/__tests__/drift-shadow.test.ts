// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { assertSeparateShadowDatabase, resetShadowAppSchema } from '../../scripts/drift-shadow';

describe('isolated migration shadow reset', () => {
  const source = 'postgresql://owner:secret@localhost:5432/office';
  it('rejects the target database even through another host, encoded name or schema', () => {
    for (const shadow of [
      source,
      'postgresql://other:secret@alias/office?schema=shadow',
      'postgresql://owner:secret@other-server/%6fffice',
      'postgresql://owner:secret@localhost/postgres',
      'postgresql://owner:secret@localhost/template1',
      'postgresql://owner:secret@localhost/',
      'postgresql://owner:secret@localhost/office_shadow?schema=other',
    ]) {
      expect(() => assertSeparateShadowDatabase(shadow, [source])).toThrow();
    }
    expect(() => assertSeparateShadowDatabase('postgresql://host/office_shadow', [])).toThrow();
    expect(() =>
      assertSeparateShadowDatabase('postgresql://host/office_shadow', [
        source,
        'postgresql://app/office_shadow',
      ]),
    ).toThrow();
    expect(
      assertSeparateShadowDatabase('postgresql://host/office_shadow?schema=public', [source]),
    ).toBe('office_shadow');
  });

  // CREATE/DROP DATABASE may wait for checkpoints on shared CI runners.
  it('clears custom app functions repeatedly in its own database without touching public data', async () => {
    const sourceUrl = process.env['DATABASE_URL']!;
    const name = 'taxtronik_drift_test_' + randomUUID().replaceAll('-', '');
    const owner = new Client({ connectionString: sourceUrl });
    const shadowUrl = new URL(sourceUrl);
    shadowUrl.pathname = '/' + name;
    shadowUrl.searchParams.set('schema', 'public');
    const shadow = new Client({ connectionString: shadowUrl.toString() });
    await owner.connect();
    try {
      await owner.query(`CREATE DATABASE "${name}"`);
      await shadow.connect();
      await shadow.query(
        'CREATE TABLE public.shadow_sentinel (id integer); INSERT INTO public.shadow_sentinel VALUES (42)',
      );
      for (let run = 0; run < 2; run++) {
        await shadow.query(
          'CREATE SCHEMA app; CREATE FUNCTION app.prior_migration() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
        );
        await resetShadowAppSchema(shadowUrl.toString(), [sourceUrl]);
        expect(
          (await shadow.query("SELECT to_regnamespace('app') AS schema")).rows[0].schema,
        ).toBeNull();
        expect((await shadow.query('SELECT id FROM public.shadow_sentinel')).rows).toEqual([
          { id: 42 },
        ]);
      }
      await expect(resetShadowAppSchema(sourceUrl, [sourceUrl])).rejects.toThrow();
      expect(
        (await owner.query("SELECT to_regclass('public.tenant') AS table_name")).rows[0].table_name,
      ).toBe('tenant');
    } finally {
      await shadow.end();
      await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await owner.end();
    }
  }, 30_000);
});
