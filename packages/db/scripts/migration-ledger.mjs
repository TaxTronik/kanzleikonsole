import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REPAIR_MIGRATION = '20260809000000_repair_known_legacy_migration_drift';
export const FORWARD_REPAIR_MIGRATION = '20260809000100_reconcile_repair_migration_history';
export const CANONICAL_REPAIR_CHECKSUM =
  '028fdbe47d7fd9901bc3b042e3dce078ac2283247b48b742f35e89db8e559d74';

// Exact ledger states produced by the two historical variants of 090000.
// The forward repair accepts them only before 090001 is applied and rewrites
// every entry to the LF checksum committed in the repository.
export const KNOWN_REPAIR_STATES = new Map([
  [
    '9f04a8abdd6a5b3e35e007855942a654bd19ea6122046415a50e07f50e7ecab6',
    new Map([
      [
        '20260801003600_poa_signing_snapshot',
        '225753c9c03bd05c717f7e0f151a7ac2ed1db87c75f86b3de4e3e6a13e3b1dfa',
      ],
      [
        '20260801003700_n8n_workflow_routes',
        'fca7f51d9eb02387fb20ee8c3319564ec3f0dc06bf9487a32f187cd4d51d0394',
      ],
      [
        '20260801003800_n8n_callback_receipts',
        'ab8a651682b04d771320c8a628047bee8e24721d84f483afc857600edd53c303',
      ],
      [
        '20260801003900_n8n_delivery_ops_index',
        '6ac5ada54eadc5d9e19a2777b77ec5aa7354eefdf04fe012a31cda99c9bb2f94',
      ],
      [
        '20260801004000_poa_created_at_db_clock',
        '169c5c5afd6dcc18d08cf9122a00e6553bce268005f462a01e9a43fe9557e605',
      ],
    ]),
  ],
  [
    '8806a22b6f2c423a37384812952aa69a92e8bf85acbf575f6d7a552763b33102',
    new Map([
      [
        '20260801003400_gwg_fail_closed_and_destruction',
        '0a14d7d3651dfef0e0cffe71c38075c3e8f08cbcc4ea54aa8da6e429bebcea6b',
      ],
      [
        '20260801003500_tax_notice_event_dates',
        'fc4f82dd6dc4ba389cd668a41a308feba3ea56965bde3913afb0cd2c35d2478f',
      ],
      [
        '20260801003510_dsgvo_request_evidence',
        '0c6e0ae08723053157c1e58f25576d04a2ceac3c4aaea31a861234af50532ffd',
      ],
      [
        '20260801003600_poa_signing_snapshot',
        '225753c9c03bd05c717f7e0f151a7ac2ed1db87c75f86b3de4e3e6a13e3b1dfa',
      ],
      [
        '20260801003700_n8n_workflow_routes',
        'fca7f51d9eb02387fb20ee8c3319564ec3f0dc06bf9487a32f187cd4d51d0394',
      ],
      [
        '20260801003800_n8n_callback_receipts',
        'ab8a651682b04d771320c8a628047bee8e24721d84f483afc857600edd53c303',
      ],
      [
        '20260801003900_n8n_delivery_ops_index',
        '6ac5ada54eadc5d9e19a2777b77ec5aa7354eefdf04fe012a31cda99c9bb2f94',
      ],
      [
        '20260801004000_poa_created_at_db_clock',
        '169c5c5afd6dcc18d08cf9122a00e6553bce268005f462a01e9a43fe9557e605',
      ],
      [
        '20260801004200_gwg_destruction_lifecycle_lock',
        'a011462a9453eaae29d0e3b5065d325970ba81803b92e97fc4e4a25c361d688b',
      ],
      [
        '20260801004300_gwg_identity_subjects_and_document_sets',
        '861f2fe53dd2e900d5697b80b9632d086f027bc3df65199232194c96e66d639e',
      ],
      [
        '20260801004400_legacy_gwg_guard_recovery',
        '4390e25b53febbb93ec0dc7c0b29793e7f5e7827bea1d8b23ff361b4faf2dd1c',
      ],
    ]),
  ],
  [CANONICAL_REPAIR_CHECKSUM, new Map()],
]);

// These five CRLF hashes were emitted by a Windows checkout before SQL files
// were pinned to LF. Treat only the exact byte variants as their canonical LF
// counterpart so the pre-gate can attest and converge affected ledgers.
export const KNOWN_EOL_VARIANTS = new Map([
  [
    '20260801003600_poa_signing_snapshot',
    '225753c9c03bd05c717f7e0f151a7ac2ed1db87c75f86b3de4e3e6a13e3b1dfa',
  ],
  [
    '20260801003700_n8n_workflow_routes',
    'fca7f51d9eb02387fb20ee8c3319564ec3f0dc06bf9487a32f187cd4d51d0394',
  ],
  [
    '20260801003800_n8n_callback_receipts',
    'ab8a651682b04d771320c8a628047bee8e24721d84f483afc857600edd53c303',
  ],
  [
    '20260801003900_n8n_delivery_ops_index',
    '6ac5ada54eadc5d9e19a2777b77ec5aa7354eefdf04fe012a31cda99c9bb2f94',
  ],
  [
    '20260801004000_poa_created_at_db_clock',
    '169c5c5afd6dcc18d08cf9122a00e6553bce268005f462a01e9a43fe9557e605',
  ],
]);

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

  const entries = readdirSync(migrationsRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const migrationName = entry.name;
    const migrationFile = join(migrationsRoot, migrationName, 'migration.sql');
    let contents;
    try {
      contents = readFileSync(migrationFile);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }

    const checksum = createHash('sha256').update(contents).digest('hex');
    const knownCrlfChecksum = KNOWN_EOL_VARIANTS.get(migrationName);
    const canonicalContents =
      knownCrlfChecksum === checksum
        ? contents.toString('utf8').replaceAll('\r\n', '\n')
        : contents;

    migrations.set(migrationName, createHash('sha256').update(canonicalContents).digest('hex'));
  }

  return migrations;
}

export function analyzeMigrationLedger({ repository, ledgerRows, phase = 'after-deploy' }) {
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

  const repairChecksum = applied.get(REPAIR_MIGRATION);
  const repairApplied = repairChecksum !== undefined;
  const repairState = KNOWN_REPAIR_STATES.get(repairChecksum);
  const forwardRepairPending = !applied.has(FORWARD_REPAIR_MIGRATION);

  for (const [migrationName, databaseChecksum] of applied) {
    const repositoryChecksum = repository.get(migrationName);
    if (!repositoryChecksum) {
      errors.push(`angewandte Migration fehlt im Repository: ${migrationName}`);
      continue;
    }
    if (databaseChecksum === repositoryChecksum) continue;

    const knownLegacy = KNOWN_LEGACY_CHECKSUMS.get(migrationName);
    const knownRepairStateChecksum = repairState?.get(migrationName);
    if (
      phase === 'before-deploy' &&
      forwardRepairPending &&
      ((migrationName === REPAIR_MIGRATION && repairState !== undefined) ||
        (!repairApplied && knownLegacy === databaseChecksum) ||
        (repairApplied && knownRepairStateChecksum === databaseChecksum))
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
