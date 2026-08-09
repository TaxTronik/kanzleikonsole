#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eslintCli = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const baselineFile = join(root, 'scripts', 'complexity-baseline.json');
const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
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

function collectFingerprints(results) {
  const ordinals = new Map();
  const fingerprints = new Map();

  for (const file of results) {
    const fileName = relative(root, file.filePath).split(sep).join('/');
    for (const message of file.messages) {
      if (message.ruleId !== 'complexity') continue;

      const parsed = /^(.*?) has a complexity of (\d+)\./.exec(message.message);
      if (!parsed) {
        throw new Error(`Unbekanntes Complexity-Meldungsformat: ${message.message}`);
      }

      const functionKey = `${fileName}::${parsed[1]}`;
      const ordinal = (ordinals.get(functionKey) ?? 0) + 1;
      ordinals.set(functionKey, ordinal);
      fingerprints.set(`${functionKey}#${ordinal}`, Number(parsed[2]));
    }
  }

  return fingerprints;
}

function compareFingerprints(expected, actual) {
  const changes = [];
  for (const [fingerprint, expectedComplexity] of Object.entries(expected)) {
    if (!actual.has(fingerprint)) {
      changes.push(`ENTFERNT  ${fingerprint} (Baseline ${expectedComplexity})`);
    } else if (actual.get(fingerprint) !== expectedComplexity) {
      changes.push(
        `GEAENDERT ${fingerprint} (${expectedComplexity} -> ${actual.get(fingerprint)})`,
      );
    }
  }
  for (const [fingerprint, complexity] of actual) {
    if (!(fingerprint in expected)) {
      changes.push(`NEU       ${fingerprint} (Komplexitaet ${complexity})`);
    }
  }
  return changes.sort();
}

let actual;
try {
  actual = collectFingerprints(report);
} catch (error) {
  console.error('[complexity-baseline]', error);
  process.exit(1);
}

const values = [...actual.values()];
const changes = compareFingerprints(baseline, actual);
console.log(
  `complexity: ${actual.size} Fingerprints (Baseline ${Object.keys(baseline).length}), ` +
    `Spitzenwert ${values.length === 0 ? 0 : Math.max(...values)} (Limit 20)`,
);

if (lint.status !== 0) {
  console.error('[complexity-baseline] ESLint meldet Fehler ausserhalb der Baseline.');
  process.stderr.write(lint.stderr || '');
  process.exit(lint.status ?? 1);
}

if (changes.length > 0) {
  console.error('[complexity-baseline] Datei-/Funktions-Baseline hat sich geaendert:');
  for (const change of changes) console.error(`  ${change}`);
  console.error(
    '[complexity-baseline] Neue oder hoehere Treffer beheben; Verbesserungen explizit in ' +
      'scripts/complexity-baseline.json nachziehen.',
  );
  process.exit(1);
}

console.log('[complexity-baseline] OK: keine neue Komplexitaetsschuld.');
