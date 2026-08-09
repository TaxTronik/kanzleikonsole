#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import {
  analyzeMigrationLedger,
  collectRepositoryMigrations,
} from './migration-ledger.mjs';

const { Client } = pg;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
const migrationsRoot = join(packageRoot, 'prisma', 'migrations');
const phase = process.argv.includes('--before-deploy')
  ? 'before-deploy'
  : 'after-deploy';

if (process.argv.includes('--before-deploy') && process.argv.includes('--after-deploy')) {
  console.error('[verify:migration-ledger] Nur eine Phase darf gesetzt sein.');
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[verify:migration-ledger] DATABASE_URL fehlt.');
  process.exit(1);
}

const repository = collectRepositoryMigrations(migrationsRoot);
if (repository.size === 0) {
  console.error('[verify:migration-ledger] Keine SQL-Migrationen gefunden.');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const journal = await client.query(
    "SELECT to_regclass('public._prisma_migrations') AS journal",
  );
  const hasJournal = journal.rows[0]?.journal !== null;

  if (!hasJournal) {
    if (phase === 'before-deploy') {
      console.log('[verify:migration-ledger] Erstinstallation ohne Ledger erkannt.');
      process.exitCode = 0;
    } else {
      console.error('[verify:migration-ledger] Prisma-Ledger fehlt nach dem Deployment.');
      process.exitCode = 1;
    }
  } else {
    const ledger = await client.query(
      `SELECT migration_name, checksum, finished_at, rolled_back_at
         FROM public._prisma_migrations
        ORDER BY started_at, migration_name`,
    );
    const result = analyzeMigrationLedger({
      repository,
      ledgerRows: ledger.rows,
      phase,
    });

    if (result.errors.length > 0) {
      console.error('[verify:migration-ledger] Ledger-Pruefung fehlgeschlagen:');
      for (const error of result.errors) console.error(`  - ${error}`);
      process.exitCode = 1;
    } else if (result.legacyMismatches.length > 0) {
      console.warn(
        '[verify:migration-ledger] Bekannter Pre-Release-Stand erkannt; ' +
          'die Reparaturmigration muss jetzt atomar angewandt werden:',
      );
      for (const migrationName of result.legacyMismatches) {
        console.warn(`  - ${migrationName}`);
      }
      process.exitCode = 0;
    } else {
      console.log(
        `[verify:migration-ledger] OK (${repository.size} Repository-Migrationen, Phase ${phase}).`,
      );
      process.exitCode = 0;
    }
  }
} catch (error) {
  console.error('[verify:migration-ledger] Datenbankpruefung fehlgeschlagen:', error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
