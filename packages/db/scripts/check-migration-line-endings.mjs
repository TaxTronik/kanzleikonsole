#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsRoot = join(packageRoot, 'prisma', 'migrations');
const invalid = [];

for (const entry of readdirSync(migrationsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const migrationFile = join(migrationsRoot, entry.name, 'migration.sql');
  let contents;
  try {
    contents = readFileSync(migrationFile);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
    throw error;
  }

  if (contents.includes('\r\n')) invalid.push(entry.name);
}

if (invalid.length > 0) {
  console.error('[migration-eol] CRLF in SQL-Migrationen gefunden:');
  for (const migrationName of invalid) console.error(`  - ${migrationName}`);
  console.error(
    '[migration-eol] Migrationen muessen gemaess .gitattributes mit LF ausgecheckt sein.',
  );
  process.exit(1);
}

console.log('[migration-eol] OK: alle SQL-Migrationen verwenden LF.');
