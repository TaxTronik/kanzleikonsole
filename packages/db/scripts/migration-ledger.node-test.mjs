import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  analyzeMigrationLedger,
  collectRepositoryMigrations,
  KNOWN_LEGACY_CHECKSUMS,
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
    ledgerRows: [
      applied(migrationName, legacyChecksum),
      applied(REPAIR_MIGRATION, 'repair'),
    ],
    phase: 'before-deploy',
  });
  assert.equal(result.errors.length, 1);
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
