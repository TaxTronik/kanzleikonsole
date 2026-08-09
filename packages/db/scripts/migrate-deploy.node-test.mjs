import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeMigrationWorkflow, loadRepositoryEnvironment } from './migrate-deploy.mjs';

function runScenario(recoveryState) {
  const calls = [];
  executeMigrationWorkflow({
    checkLineEndings: () => calls.push('eol'),
    inspectRecovery: () => recoveryState,
    verifyLedger: (phase) => calls.push(`ledger:${phase}`),
    runPrisma: (args) => calls.push(`prisma:${args.join(' ')}`),
  });
  return calls;
}

test('loads DATABASE_URL from the repository env file without overriding the process', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'migration-deploy-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envFile = join(root, '.env');
  writeFileSync(envFile, 'DATABASE_URL=postgresql://from-file\n');
  const previous = process.env.DATABASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });

  delete process.env.DATABASE_URL;
  loadRepositoryEnvironment(envFile);
  assert.equal(process.env.DATABASE_URL, 'postgresql://from-file');

  process.env.DATABASE_URL = 'postgresql://from-process';
  loadRepositoryEnvironment(envFile);
  assert.equal(process.env.DATABASE_URL, 'postgresql://from-process');
});

test('runs line endings, both ledger gates and deploy in order without a journal', () => {
  assert.deepEqual(runScenario('no-journal'), [
    'eol',
    'ledger:before-deploy',
    'prisma:migrate deploy',
    'ledger:after-deploy',
  ]);
});

test('resolves only the attested recoverable migration before deploy', () => {
  assert.deepEqual(runScenario('recoverable'), [
    'eol',
    'prisma:migrate resolve --rolled-back 20260801003400_gwg_fail_closed_and_destruction',
    'ledger:before-deploy',
    'prisma:migrate deploy',
    'ledger:after-deploy',
  ]);
});

test('keeps every other recovery state fail-closed', () => {
  assert.throws(() => runScenario('unexpected'), /Unbekanntes Ergebnis/);
});
