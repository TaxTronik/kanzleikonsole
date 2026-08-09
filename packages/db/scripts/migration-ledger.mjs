import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REPAIR_MIGRATION =
  '20260809000000_repair_known_legacy_migration_drift';

// Exact hashes observed on the affected pre-release database. They are only
// accepted by the pre-deploy gate while the forward repair is still pending.
export const KNOWN_LEGACY_CHECKSUMS = new Map([
  [
    '20260801003400_gwg_fail_closed_and_destruction',
    '20e0ac5a2c1d6d47c7c606cd3915b6297418c25ece1695e345152ebc20296152',
  ],
  [
    '20260801003500_tax_notice_event_dates',
    'aca1080fb6a838263c178ffc9ee6966168df08338a82d5c8c2f2cf5133404d05',
  ],
  [
    '20260801003510_dsgvo_request_evidence',
    '85f37286af75f978f46e80f026768f1bfa36243f8717f6152ac3118574501966',
  ],
  [
    '20260801003600_poa_signing_snapshot',
    '6a180f40b3d7e57f3bee1623b1e05d8759ae773a90b2ae3e882e1b847c43bab6',
  ],
  [
    '20260801003700_n8n_workflow_routes',
    'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387',
  ],
  [
    '20260801003800_n8n_callback_receipts',
    '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a',
  ],
  [
    '20260801003900_n8n_delivery_ops_index',
    'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1',
  ],
  [
    '20260801004000_poa_created_at_db_clock',
    '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1',
  ],
  [
    '20260801004200_gwg_destruction_lifecycle_lock',
    '90efb4b93035dbb4b685b8b2f36395badaabe3cb0e36389031a21155e90479ed',
  ],
  [
    '20260801004300_gwg_identity_subjects_and_document_sets',
    'a7c91cb2cefdff27708b8f725a2c5bcee24578fdce8899f09b25bf8c124154d1',
  ],
  [
    '20260801004400_legacy_gwg_guard_recovery',
    'b84f3eff33972398cfde95521cc44671639fc0f34bbfb0f872afbc2e19951b6f',
  ],
]);

export function collectRepositoryMigrations(migrationsRoot) {
  const migrations = new Map();

  for (const migrationName of readdirSync(migrationsRoot).sort()) {
    const migrationFile = join(migrationsRoot, migrationName, 'migration.sql');
    let contents;
    try {
      contents = readFileSync(migrationFile);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }

    migrations.set(
      migrationName,
      createHash('sha256').update(contents).digest('hex'),
    );
  }

  return migrations;
}

export function analyzeMigrationLedger({
  repository,
  ledgerRows,
  phase = 'after-deploy',
}) {
  if (phase !== 'before-deploy' && phase !== 'after-deploy') {
    throw new Error(`Unsupported ledger verification phase: ${phase}`);
  }

  const errors = [];
  const legacyMismatches = [];
  const applied = new Map();

  for (const row of ledgerRows) {
    if (row.finished_at === null && row.rolled_back_at === null) {
      errors.push(`unvollstaendige Migration: ${row.migration_name}`);
      continue;
    }
    if (row.finished_at === null || row.rolled_back_at !== null) continue;
    if (applied.has(row.migration_name)) {
      errors.push(`mehrfach aktiv journalisiert: ${row.migration_name}`);
      continue;
    }
    applied.set(row.migration_name, row.checksum);
  }

  const repairApplied = applied.has(REPAIR_MIGRATION);

  for (const [migrationName, databaseChecksum] of applied) {
    const repositoryChecksum = repository.get(migrationName);
    if (!repositoryChecksum) {
      errors.push(`angewandte Migration fehlt im Repository: ${migrationName}`);
      continue;
    }
    if (databaseChecksum === repositoryChecksum) continue;

    const knownLegacy = KNOWN_LEGACY_CHECKSUMS.get(migrationName);
    if (
      phase === 'before-deploy' &&
      !repairApplied &&
      knownLegacy === databaseChecksum
    ) {
      legacyMismatches.push(migrationName);
      continue;
    }

    errors.push(
      `Checksum-Abweichung: ${migrationName} ` +
        `(DB ${databaseChecksum}, Repository ${repositoryChecksum})`,
    );
  }

  if (phase === 'after-deploy') {
    for (const migrationName of repository.keys()) {
      if (!applied.has(migrationName)) {
        errors.push(`Migration noch nicht angewandt: ${migrationName}`);
      }
    }
  }

  return { errors, legacyMismatches };
}
