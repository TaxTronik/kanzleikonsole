// =============================================================================
// Prueft den Laufzeitbaum des Worker-Images (Dockerfile.worker) nach
// `pnpm deploy --prod`, bevor er ins Runtime-Image kopiert wird:
//   - jeder externe Import des Bundles loest dort zur selben Paketversion auf
//     wie beim Buendeln (dist/runtime-packages.json, scripts/build.mjs),
//   - der Prisma-Client ist fuer genau diesen Baum generiert,
//   - Build- und Testwerkzeuge fehlen.
// Aufruf: node scripts/verify-runtime.mjs <Verzeichnis mit node_modules>
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(process.argv[2] ?? '');
const FORBIDDEN = [
  'typescript',
  'vitest',
  '@vitest',
  'vite',
  'tsx',
  'esbuild',
  'eslint',
  'prettier',
];

const expected = JSON.parse(readFileSync(join(workerRoot, 'dist/runtime-packages.json'), 'utf8'));
const problems = [];

for (const name of FORBIDDEN.filter((tool) => existsSync(join(appRoot, 'node_modules', tool)))) {
  problems.push(`Build-/Testwerkzeug: ${name}`);
}
if (!existsSync(join(appRoot, 'node_modules/.prisma/client/default.js'))) {
  problems.push('Prisma-Client fehlt (node_modules/.prisma/client)');
}

// Wie das Bundle zur Laufzeit: ESM-Aufloesung relativ zum App-Verzeichnis.
const probe = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const found = {};
for (const [specifier, wanted] of Object.entries(JSON.parse(process.argv[1]))) {
  const name = wanted.slice(0, wanted.lastIndexOf('@'));
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(specifier)));
    while (!existsSync(join(dir, 'package.json')) ||
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name) {
      if (dir === dirname(dir)) throw new Error('Paketwurzel fehlt');
      dir = dirname(dir);
    }
    found[specifier] = name + '@' + JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch (error) {
    found[specifier] = 'nicht aufloesbar (' + error.message + ')';
  }
}
process.stdout.write(JSON.stringify(found));
`,
    JSON.stringify(expected),
  ],
  { cwd: appRoot, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
);
if (probe.status !== 0) {
  throw new Error(`[worker-runtime] Aufloesungsprobe fehlgeschlagen:\n${probe.stderr}`);
}
const found = JSON.parse(probe.stdout);
for (const [specifier, wanted] of Object.entries(expected)) {
  if (found[specifier] !== wanted) {
    problems.push(`${specifier}: erwartet ${wanted}, gefunden ${found[specifier]}`);
  }
}

if (problems.length > 0) {
  throw new Error(
    `[worker-runtime] Laufzeitbaum ${appRoot} ungueltig:\n  - ${problems.join('\n  - ')}`,
  );
}
console.log(
  `[worker-runtime] OK: ${Object.keys(expected).length} externe Importe, Prisma-Client, ` +
    'keine Build-/Testwerkzeuge.',
);
