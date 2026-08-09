#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptFile);
const packageRoot = resolve(scriptDir, '..');
const repositoryEnv = resolve(packageRoot, '..', '..', '.env');
const migration = '20260801003400_gwg_fail_closed_and_destruction';

export function loadRepositoryEnvironment(envFile = repositoryEnv) {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function executeMigrationWorkflow({
  checkLineEndings,
  inspectRecovery,
  verifyLedger,
  runPrisma,
}) {
  checkLineEndings();
  const recoveryState = inspectRecovery();
  if (recoveryState === 'recoverable') {
    console.log(
      'INFO: Vollstaendig zurueckgerollten GwG-Migrationsfehler 03400 erkannt; ' +
        'Prisma-Journal wird sicher freigegeben.',
    );
    runPrisma(['migrate', 'resolve', '--rolled-back', migration]);
  } else if (recoveryState !== 'no-journal' && recoveryState !== 'not-recoverable') {
    throw new Error(`Unbekanntes Ergebnis der Migration-Recovery-Pruefung: ${recoveryState}`);
  }

  verifyLedger('before-deploy');
  runPrisma(['migrate', 'deploy']);
  verifyLedger('after-deploy');
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: process.env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} fehlgeschlagen (Exit ${result.status}).`);
  }
  return capture ? (result.stdout ?? '').trim() : '';
}

function parsePrismaCli(args) {
  if (args.length === 0) return createRequire(import.meta.url).resolve('prisma/build/index.js');
  if (args.length === 2 && args[0] === '--prisma-cli') return resolve(args[1]);
  throw new Error('Aufruf: migrate-deploy.mjs [--prisma-cli <prisma/build/index.js>]');
}

export function main(args = process.argv.slice(2)) {
  loadRepositoryEnvironment();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL fehlt (Prozess und .env).');

  const prismaCli = parsePrismaCli(args);
  const lineEndingCheck = resolve(scriptDir, 'check-migration-line-endings.mjs');
  const recoveryCheck = resolve(scriptDir, 'inspect-migration-recovery.mjs');
  const ledgerCheck = resolve(scriptDir, 'verify-migration-ledger.mjs');

  executeMigrationWorkflow({
    checkLineEndings: () => run(process.execPath, [lineEndingCheck]),
    inspectRecovery: () => run(process.execPath, [recoveryCheck], { capture: true }),
    verifyLedger: (phase) => run(process.execPath, [ledgerCheck, `--${phase}`]),
    runPrisma: (prismaArgs) => run(process.execPath, [prismaCli, ...prismaArgs]),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  try {
    main();
  } catch (error) {
    console.error('[migrate:deploy] FATAL:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
