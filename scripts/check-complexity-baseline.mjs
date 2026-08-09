#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslintCli = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const expected = 105;
const lint = spawnSync(process.execPath, [eslintCli, '.', '--format', 'json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 100 * 1024 * 1024,
});

if (!lint.stdout) {
  process.stderr.write(lint.stderr || '[complexity-baseline] ESLint lieferte kein Ergebnis.\n');
  process.exit(lint.status ?? 1);
}

let report;
try {
  report = JSON.parse(lint.stdout);
} catch (error) {
  console.error('[complexity-baseline] ESLint-JSON ist ungueltig:', error);
  process.stderr.write(lint.stderr || '');
  process.exit(1);
}

let actual = 0;
for (const file of report) {
  for (const message of file.messages) {
    if (message.ruleId === 'complexity') actual += 1;
  }
}

console.log(`complexity: ${actual} (Baseline ${expected}, Maximum 20)`);
if (lint.status !== 0) {
  console.error('[complexity-baseline] ESLint meldet Fehler ausserhalb der Baseline.');
  process.stderr.write(lint.stderr || '');
  process.exit(lint.status ?? 1);
}
if (actual !== expected) {
  console.error(
    '[complexity-baseline] Baseline hat sich geaendert. ' +
      'Neue Treffer beheben; bei Reduktionen den Wert im Gate absenken.',
  );
  process.exit(1);
}

console.log('[complexity-baseline] OK: keine neue Komplexitaetsschuld.');
