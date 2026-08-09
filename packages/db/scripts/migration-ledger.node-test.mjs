import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  analyzeMigrationLedger,
  CANONICAL_REPAIR_CHECKSUM,
  collectRepositoryMigrations,
  FORWARD_REPAIR_MIGRATION,
  KNOWN_EOL_VARIANTS,
  KNOWN_LEGACY_CHECKSUMS,
  KNOWN_REPAIR_STATES,
  REPAIR_MIGRATION,
} from './migration-ledger.mjs';

function applied(migration_name, checksum) {
  return {
    migration_name,
    checksum,
    finished_at: new Date(),
    rolled_back_at: null,
  };
}

test('collects migration directories and ignores migration metadata files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'migration-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'migration_lock.toml'), 'provider = "postgresql"\n');
  const migration = join(root, '001_init');
  mkdirSync(migration);
  writeFileSync(join(migration, 'migration.sql'), 'SELECT 1;\n');

  const repository = collectRepositoryMigrations(root);

  assert.deepEqual([...repository.keys()], ['001_init']);
  assert.match(repository.get('001_init'), /^[0-9a-f]{64}$/);
});

test('canonicalizes the exact attested CRLF migration variants', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'migration-ledger-crlf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const migrationName = '20260801003600_poa_signing_snapshot';
  const sourceFile = join(
    import.meta.dirname,
    '..',
    'prisma',
    'migrations',
    migrationName,
    'migration.sql',
  );
  const crlfContents = readFileSync(sourceFile, 'utf8')
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', '\r\n');
  const migration = join(root, migrationName);
  mkdirSync(migration);
  writeFileSync(join(migration, 'migration.sql'), crlfContents);

  const repository = collectRepositoryMigrations(root);
  assert.equal(
    KNOWN_EOL_VARIANTS.get(migrationName),
    '225753c9c03bd05c717f7e0f151a7ac2ed1db87c75f86b3de4e3e6a13e3b1dfa',
  );
  assert.equal(
    repository.get(migrationName),
    '94d412607abcca7ef88748dd75629821398369f01acbcc6e2f13c92518923d1d',
  );
});

test('rejects an unknown historical checksum before deploy', () => {
  const repository = new Map([['001_init', 'repo']]);
  const result = analyzeMigrationLedger({
    repository,
    ledgerRows: [applied('001_init', 'tampered')],
    phase: 'before-deploy',
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Checksum-Abweichung/);
});

test('allows only an attested legacy checksum while the repair is pending', () => {
  const [migrationName, legacyChecksum] = KNOWN_LEGACY_CHECKSUMS.entries().next().value;
  const repository = new Map([
    [migrationName, 'canonical'],
    [REPAIR_MIGRATION, 'repair'],
  ]);
  const result = analyzeMigrationLedger({
    repository,
    ledgerRows: [applied(migrationName, legacyChecksum)],
    phase: 'before-deploy',
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.legacyMismatches, [migrationName]);
});

test('rejects a legacy checksum after the repair was applied', () => {
  const [migrationName, legacyChecksum] = KNOWN_LEGACY_CHECKSUMS.entries().next().value;
  const repository = new Map([
    [migrationName, 'canonical'],
    [REPAIR_MIGRATION, 'repair'],
  ]);
  const result = analyzeMigrationLedger({
    repository,
    ledgerRows: [applied(migrationName, legacyChecksum), applied(REPAIR_MIGRATION, 'repair')],
    phase: 'before-deploy',
  });
  assert.equal(result.errors.length, 1);
});

test('allows every attested 090000 ledger state until 090001 converges it', () => {
  for (const [repairChecksum, state] of KNOWN_REPAIR_STATES) {
    if (repairChecksum === CANONICAL_REPAIR_CHECKSUM) continue;

    const repository = new Map([
      [REPAIR_MIGRATION, CANONICAL_REPAIR_CHECKSUM],
      [FORWARD_REPAIR_MIGRATION, 'forward'],
      ...[...state.keys()].map((migrationName) => [migrationName, 'canonical']),
    ]);
    const result = analyzeMigrationLedger({
      repository,
      ledgerRows: [
        ...[...state].map(([migrationName, checksum]) => applied(migrationName, checksum)),
        applied(REPAIR_MIGRATION, repairChecksum),
      ],
      phase: 'before-deploy',
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.legacyMismatches.length, state.size + 1);
  }
});

test('rejects a historical 090000 checksum after 090001 was applied', () => {
  const historicalChecksum = [...KNOWN_REPAIR_STATES.keys()].find(
    (checksum) => checksum !== CANONICAL_REPAIR_CHECKSUM,
  );
  const repository = new Map([
    [REPAIR_MIGRATION, CANONICAL_REPAIR_CHECKSUM],
    [FORWARD_REPAIR_MIGRATION, 'forward'],
  ]);
  const result = analyzeMigrationLedger({
    repository,
    ledgerRows: [
      applied(REPAIR_MIGRATION, historicalChecksum),
      applied(FORWARD_REPAIR_MIGRATION, 'forward'),
    ],
    phase: 'before-deploy',
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Checksum-Abweichung/);
});

test('requires a complete exact ledger after deploy', () => {
  const repository = new Map([
    ['001_init', 'one'],
    ['002_next', 'two'],
  ]);
  const result = analyzeMigrationLedger({
    repository,
    ledgerRows: [applied('001_init', 'one')],
    phase: 'after-deploy',
  });
  assert.deepEqual(result.legacyMismatches, []);
  assert.deepEqual(result.errors, ['Migration noch nicht angewandt: 002_next']);
});

test('rejects open and repository-foreign migration rows', () => {
  const repository = new Map([['001_init', 'one']]);
  const result = analyzeMigrationLedger({
    repository,
    ledgerRows: [
      {
        migration_name: '001_init',
        checksum: 'one',
        finished_at: null,
        rolled_back_at: null,
      },
      applied('999_foreign', 'foreign'),
    ],
    phase: 'before-deploy',
  });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /unvollstaendige Migration/);
  assert.match(result.errors[1], /fehlt im Repository/);
});
