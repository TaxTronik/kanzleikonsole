#!/usr/bin/env node

import pg from 'pg';

const { Client } = pg;
const migration = '20260801003400_gwg_fail_closed_and_destruction';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('[migration-recovery] DATABASE_URL fehlt.');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const journal = await client.query(
    "SELECT pg_catalog.to_regclass('public._prisma_migrations') AS journal",
  );
  if (journal.rows[0]?.journal === null) {
    console.log('no-journal');
  } else {
    const result = await client.query(
      `SELECT
         EXISTS (
           SELECT 1
             FROM public._prisma_migrations
            WHERE migration_name = $1
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
              AND applied_steps_count = 0
              AND logs LIKE '%42883%'
              AND logs LIKE '%destroy_gwg_check(uuid)%'
         )
         AND pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)') IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE (table_schema, table_name, column_name) IN (
              ('public', 'gwg_check', 'legal_form'),
              ('public', 'gwg_check', 'register_number'),
              ('public', 'gwg_check', 'register_authority'),
              ('public', 'gwg_check', 'no_register_entry'),
              ('public', 'gwg_check', 'representative_names'),
              ('public', 'gwg_check', 'ownership_structure_notes'),
              ('public', 'document', 'gwg_onboarding_invite_id'),
              ('public', 'document', 'gwg_destruction_requested_at'),
              ('public', 'document', 'gwg_destruction_requested_by'),
              ('public', 'document', 'gwg_destruction_error'),
              ('public', 'document', 'gwg_destroyed_at')
            )
         ) AS recoverable`,
      [migration],
    );
    console.log(result.rows[0]?.recoverable ? 'recoverable' : 'not-recoverable');
  }
} catch (error) {
  console.error('[migration-recovery] Datenbankpruefung fehlgeschlagen:', error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
