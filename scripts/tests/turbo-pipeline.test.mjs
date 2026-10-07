// B-07: Turbo-Pipeline ohne Schein-Builds und mit korrekten Cache-Schlüsseln.
//
// - Pakete, die nur TypeScript-Quellen exportieren, haben kein `build`-Skript
//   (frühere Schein-Builds `tsc --noEmit`); geprüft wird nur in `typecheck`.
// - `typecheck` hängt über den leeren Task `transit` an den Abhängigkeiten:
//   Ohne ihn bliebe der Hash eines Pakets gleich, wenn sich ein genutztes
//   Workspace-Paket ändert, und Turbo spielte ein veraltetes Ergebnis ab.
// - `test` wird nie aus dem Cache abgespielt: Tests lesen Dateien außerhalb
//   ihres Pakets (Workflows, ESLint-Konfiguration, Fachkatalog), und jeder
//   CI-Lauf braucht sein eigenes Testprotokoll.
// - Dateien außerhalb von Paketen, die ein TypeScript-Programm per relativem
//   Import einbindet (z. B. eslint.config.mjs), sind Eingaben des Tasks.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(ROOT, 'package.json'));
const ts = require('typescript');
const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
const posix = (path) => path.split(sep).join('/');

const workspacePackages = ['apps', 'packages'].flatMap((group) =>
  readdirSync(join(ROOT, group), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(ROOT, group, entry.name, 'package.json')),
    )
    .map((entry) => {
      const dir = `${group}/${entry.name}`;
      const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
      return { dir, name: manifest.name, scripts: manifest.scripts ?? {} };
    }),
);

function taskDefinition(pkg, task) {
  return turbo.tasks[`${pkg.name}#${task}`] ?? turbo.tasks[task];
}

const SPECIFIERS = [
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/g,
];
const EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.mjs',
  '.json',
  '/index.ts',
];

/** Dateien außerhalb der Workspace-Pakete, die das TS-Programm eines Pakets relativ importiert. */
function externalImports(pkg) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, pkg.dir, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  const external = new Set();
  for (const file of parsed.fileNames) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of SPECIFIERS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const base = resolve(dirname(file), specifier);
        const target = EXTENSIONS.map((ext) => base + ext).find((candidate) =>
          existsSync(candidate),
        );
        if (!target) continue;
        const path = posix(relative(ROOT, target));
        if (workspacePackages.some((other) => path.startsWith(`${other.dir}/`))) continue;
        external.add(path);
      }
    }
  }
  return [...external].sort();
}

test('keine Schein-Builds: nur echte Build-Schritte heißen build', () => {
  for (const pkg of workspacePackages) {
    const build = pkg.scripts.build;
    if (build === undefined) continue;
    assert.ok(
      !/^tsc(?:\s|$)/.test(build) || !/--noEmit/.test(build),
      `${pkg.dir}: build "${build}"`,
    );
  }
  assert.deepEqual(turbo.tasks.build.dependsOn, ['^build']);
});

test('typecheck und test hängen über transit an ihren Abhängigkeiten', () => {
  assert.deepEqual(turbo.tasks.transit, { dependsOn: ['^transit'] });
  for (const [task, definition] of Object.entries(turbo.tasks)) {
    const [, name] = /^(?:[^#]+#)?(.+)$/.exec(task);
    if (name === 'typecheck' || name === 'test') {
      assert.ok(definition.dependsOn?.includes('transit'), `${task} ohne transit`);
    }
    if (name === 'test') assert.equal(definition.cache, false, `${task} darf nicht cachen`);
  }
  // Kein Paket darf ein Skript namens transit haben, sonst liefe es.
  for (const pkg of workspacePackages) assert.equal(pkg.scripts.transit, undefined, pkg.dir);
});

test('externe TypeScript-Importe sind Eingaben von typecheck (und build)', (t) => {
  for (const pkg of workspacePackages) {
    if (!pkg.scripts.typecheck || !existsSync(join(ROOT, pkg.dir, 'tsconfig.json'))) continue;
    const external = externalImports(pkg);
    if (external.length === 0) continue;
    t.diagnostic(`${pkg.dir}: ${external.join(', ')}`);
    for (const task of ['typecheck', 'build']) {
      if (task === 'build' && pkg.scripts.build === undefined) continue;
      const inputs = taskDefinition(pkg, task)?.inputs ?? [];
      const roots = inputs
        .filter((input) => input.startsWith('$TURBO_ROOT$/'))
        .map((input) => input.slice('$TURBO_ROOT$/'.length));
      assert.ok(inputs.includes('$TURBO_DEFAULT$'), `${pkg.name}#${task}: $TURBO_DEFAULT$ fehlt`);
      for (const file of external) {
        assert.ok(
          roots.some((glob) => matchesGlob(file, glob)),
          `${pkg.name}#${task}: ${file} ist keine Eingabe (turbo.json)`,
        );
      }
    }
  }
});
