#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslintCli = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const baseline = new Map([
  ['react-hooks/purity', 0],
  ['react-hooks/set-state-in-effect', 0],
  ['react-hooks/refs', 0],
  ['react-hooks/immutability', 0],
  ['react-hooks/preserve-manual-memoization', 0],
  ['react-hooks/static-components', 0],
]);

const lint = spawnSync(process.execPath, [eslintCli, 'apps/web', '--format', 'json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 100 * 1024 * 1024,
});

if (!lint.stdout) {
  process.stderr.write(lint.stderr || '[react-compiler-baseline] ESLint lieferte kein Ergebnis.\n');
  process.exit(lint.status ?? 1);
}

let report;
try {
  report = JSON.parse(lint.stdout);
} catch (error) {
  console.error('[react-compiler-baseline] ESLint-JSON ist ungueltig:', error);
  process.stderr.write(lint.stderr || '');
  process.exit(1);
}

const counts = new Map([...baseline.keys()].map((rule) => [rule, 0]));
for (const file of report) {
  for (const message of file.messages) {
    if (counts.has(message.ruleId)) {
      counts.set(message.ruleId, counts.get(message.ruleId) + 1);
    }
  }
}

const differences = [];
for (const [rule, expected] of baseline) {
  const actual = counts.get(rule) ?? 0;
  console.log(`${rule}: ${actual} (Baseline ${expected})`);
  if (actual !== expected) differences.push({ rule, expected, actual });
}

if (lint.status !== 0) {
  console.error('[react-compiler-baseline] ESLint meldet Fehler ausserhalb der Baseline.');
  process.stderr.write(lint.stderr || '');
  process.exit(lint.status ?? 1);
}

if (differences.length > 0) {
  console.error(
    '[react-compiler-baseline] Baseline hat sich geaendert. ' +
      'Neue Treffer beheben; bei Reduktionen die Zahlen im Gate absenken.',
  );
  for (const difference of differences) {
    console.error(
      `  - ${difference.rule}: erwartet ${difference.expected}, gefunden ${difference.actual}`,
    );
  }
  process.exit(1);
}

console.log('[react-compiler-baseline] OK: keine React-Compiler-Warnungen.');
