// =============================================================================
// Produktions-Bundle des Workers fuer infra/docker/Dockerfile.worker.
//
// Das Image startet `node --enable-source-maps dist/index.js` statt tsx.
// Daneben entsteht dist/env-check.js: die Konfigurationspruefung, die die
// Operator-CLI vor Backup und Migration im Ziel-Image ausfuehrt (B-05). Beide
// Einstiege sind eigenstaendige Bundles. Die
// Workspace-Pakete (@taxtronik/*) exportieren TypeScript-Quellen und werden
// eingebunden. Drittpakete bleiben extern und kommen zur Laufzeit aus dem per
// `pnpm deploy --prod` befuellten node_modules. Loest das importierende Paket
// ein Drittpaket anders auf als das Bundle (im flachen Baum verschachtelte
// Version), wird es eingebunden, damit die deklarierte Version erhalten bleibt.
// dist/runtime-packages.json haelt fuer jeden externen Import beider Einstiege
// Paket und Version fest; scripts/verify-runtime.mjs prueft den Laufzeitbaum
// dagegen.
// =============================================================================

import { build } from 'esbuild';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(workerRoot, 'dist');
const SKIP = Symbol('skip');
// Einstiege des Images: Worker-Prozess und Konfigurationspruefung (B-05).
const ENTRY_POINTS = { index: 'src/index.ts', 'env-check': 'src/env-check.ts' };

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Paketwurzel (realpath) und Version der aufgeloesten Datei. */
function packageOf(file, name) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    if (json.name === name) return { root: realpathSync(dir), version: json.version };
  }
  throw new Error(`[worker-build] Paketwurzel von ${name} nicht gefunden (${file})`);
}

const runtimePackages = new Map();

const externalThirdParty = {
  name: 'external-third-party',
  setup(bundler) {
    bundler.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === SKIP || args.kind === 'entry-point') return undefined;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      if (args.path.startsWith('@taxtronik/')) return undefined;
      const name = packageName(args.path);
      const options = { kind: args.kind, pluginData: SKIP };
      const fromImporter = await bundler.resolve(args.path, {
        ...options,
        resolveDir: args.resolveDir,
      });
      const fromBundle = await bundler.resolve(args.path, { ...options, resolveDir: workerRoot });
      if (fromImporter.errors.length > 0) return undefined;
      const wanted = packageOf(fromImporter.path, name);
      if (fromBundle.errors.length > 0 || packageOf(fromBundle.path, name).root !== wanted.root) {
        return undefined;
      }
      runtimePackages.set(args.path, `${name}@${wanted.version}`);
      return { path: args.path, external: true };
    });
  },
};

rmSync(outdir, { recursive: true, force: true });
const result = await build({
  absWorkingDir: workerRoot,
  entryPoints: ENTRY_POINTS,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  sourcesContent: false,
  keepNames: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  plugins: [externalThirdParty],
});

// Eingebundener CommonJS-Code wuerde im ESM-Bundle erst zur Laufzeit an
// `require` scheitern; dann lieber hier abbrechen.
for (const name of Object.keys(ENTRY_POINTS)) {
  const bundle = readFileSync(join(outdir, `${name}.js`), 'utf8');
  if (bundle.includes('Dynamic require of')) {
    throw new Error(
      `[worker-build] dist/${name}.js enthaelt dynamisches require() eines CommonJS-Moduls.`,
    );
  }
}
const inlined = Object.keys(result.metafile.inputs)
  .filter((input) => input.includes('node_modules/'))
  .map((input) => input.replace(/^.*node_modules\/((?:@[^/]+\/)?[^/]+).*$/, '$1'));
writeFileSync(
  join(outdir, 'runtime-packages.json'),
  `${JSON.stringify(Object.fromEntries([...runtimePackages].sort()), null, 2)}\n`,
);
console.log(
  `[worker-build] dist/index.js + dist/env-check.js: ${runtimePackages.size} externe Importe` +
    (inlined.length > 0 ? `, eingebunden: ${[...new Set(inlined)].sort().join(', ')}` : ''),
);
