import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');
const manifestPath = resolve(
  webRoot,
  '.next/server/app/api/staff/admin/backups/run/route.js.nft.json',
);

if (!existsSync(manifestPath)) {
  throw new Error(`[standalone-trace] Backup-Route-Manifest fehlt: ${manifestPath}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.files)) {
  throw new Error('[standalone-trace] Ungültiges NFT-Manifest: files fehlt.');
}

const appSourceRoot = resolve(webRoot, 'src');
const backupRoot = resolve(repoRoot, 'backups');
const forbiddenConfigFiles = new Set(
  [
    'next.config.mjs',
    'postcss.config.mjs',
    'tailwind.config.ts',
    'tsconfig.json',
    'tsconfig.tsbuildinfo',
    'turbo.json',
    'vitest.config.ts',
  ].map((name) => resolve(webRoot, name)),
);

function isInside(path, root) {
  return path === root || path.startsWith(root + sep);
}

const forbiddenTraceEntries = manifest.files
  .map((entry) => resolve(dirname(manifestPath), entry))
  .filter(
    (path) =>
      isInside(path, appSourceRoot) || isInside(path, backupRoot) || forbiddenConfigFiles.has(path),
  );

function regularFilesBelow(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

const standaloneRoot = resolve(webRoot, '.next/standalone');
const standaloneAppRoot = resolve(standaloneRoot, relative(repoRoot, webRoot));
const standaloneRequire = createRequire(resolve(standaloneAppRoot, 'server.js'));
// A successful build must not silently resolve the isolated workers' parsers
// from the host checkout. They must remain available after deployment of
// standalone/ (pdf-lib: PDF preflight and identity page count, P-13;
// unpdf/mammoth: text extraction, P-22). Traced via outputFileTracingIncludes.
const workerParsers = ['pdf-lib', 'unpdf', 'mammoth'];
for (const parser of workerParsers) {
  const parserPath = standaloneRequire.resolve(parser);
  if (!isInside(realpathSync(parserPath), realpathSync(standaloneRoot))) {
    throw new Error(`[standalone-trace] Der Worker-Parser ${parser} fehlt im Standalone-Paket.`);
  }
}
// Load them the way the worker threads do (createRequire from server.js,
// src/server/util/worker-parser.ts) in a separate process without NODE_PATH:
// every loaded module, including transitive dependencies, must come from
// standalone/.
const parserProbe = spawnSync(
  process.execPath,
  [
    '-e',
    `
const { createRequire } = require('node:module');
const { realpathSync } = require('node:fs');
const { sep } = require('node:path');
const [root, base, ...parsers] = process.argv.slice(1);
const load = createRequire(base);
for (const parser of parsers) load(parser);
const outside = Object.keys(require.cache).filter(
  (file) => !realpathSync(file).startsWith(realpathSync(root) + sep),
);
if (outside.length > 0) {
  console.error(outside.join('\\n'));
  process.exit(1);
}
`,
    standaloneRoot,
    resolve(standaloneAppRoot, 'server.js'),
    ...workerParsers,
  ],
  { cwd: standaloneRoot, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
);
if (parserProbe.status !== 0) {
  throw new Error(
    `[standalone-trace] Worker-Parser im Standalone-Paket nicht vollständig ladbar:\n${parserProbe.stderr}`,
  );
}
// Ebenso lädt der Worker-Thread-Pool der Staff-Passwortprüfung bcryptjs als
// echtes Node-Modul (server/auth/password-hash-pool.ts): per ESM-Import relativ
// zum Arbeitsverzeichnis des Standalone-Servers. Genau diese Auflösung prüfen.
const bcryptUrl = execFileSync(
  process.execPath,
  ['--input-type=module', '-e', "process.stdout.write(import.meta.resolve('bcryptjs'))"],
  { cwd: standaloneAppRoot, encoding: 'utf8' },
);
const bcryptPath = fileURLToPath(bcryptUrl);
const bcryptModule = await import(bcryptUrl);
if (
  !isInside(realpathSync(bcryptPath), realpathSync(standaloneRoot)) ||
  typeof (bcryptModule.default ?? bcryptModule).compareSync !== 'function'
) {
  throw new Error('[standalone-trace] bcryptjs fehlt im Standalone-Paket (Passwort-Pool).');
}
const forbiddenStandaloneFiles = [
  ...regularFilesBelow(resolve(standaloneRoot, 'backups')),
  ...regularFilesBelow(resolve(standaloneRoot, 'apps/web/src')).filter((path) =>
    ['.ts', '.tsx'].includes(extname(path)),
  ),
];

// S-10: Die PDF-Schriften liest nur der Server. Sie dürfen nicht unter public/
// liegen (sonst ohne Sitzung abrufbar) und müssen unverändert, samt Manifest
// und Lizenztexten, im Standalone-Paket stehen (outputFileTracingIncludes).
const fontSourceRoot = resolve(webRoot, 'assets/fonts/noto');
const standaloneFontRoot = resolve(standaloneAppRoot, 'assets/fonts/noto');
const fontManifest = JSON.parse(readFileSync(resolve(fontSourceRoot, 'manifest.json'), 'utf8'));
const notoHashes = new Set(fontManifest.fonts.map(({ sha256 }) => sha256));
const fontProblems = [
  ...fontManifest.fonts
    .filter(({ file, sha256 }) => {
      const traced = resolve(standaloneFontRoot, file);
      return (
        !existsSync(traced) ||
        createHash('sha256').update(readFileSync(traced)).digest('hex') !== sha256
      );
    })
    .map(({ file }) => `fehlt oder weicht ab: ${file}`),
  ...['manifest.json', 'OFL.txt', 'OFL-NotoSans.txt']
    .filter((file) => !existsSync(resolve(standaloneFontRoot, file)))
    .map((file) => `fehlt: ${file}`),
  ...(existsSync(resolve(webRoot, 'public/fonts')) ? ['public/fonts existiert wieder'] : []),
  // public/identity-assets enthält bewusst öffentliche PDF.js-Standardschriften;
  // geprüft wird gezielt, dass keine der eingebetteten Noto-Dateien öffentlich liegt.
  ...regularFilesBelow(resolve(webRoot, 'public'))
    .filter((path) => notoHashes.has(createHash('sha256').update(readFileSync(path)).digest('hex')))
    .map((path) => `öffentlich abrufbar: ${relative(repoRoot, path)}`),
];
if (fontProblems.length > 0) {
  throw new Error(`[standalone-trace] PDF-Schriften:\n  - ${fontProblems.join('\n  - ')}`);
}

const violations = [...new Set([...forbiddenTraceEntries, ...forbiddenStandaloneFiles])];
if (violations.length > 0) {
  const details = violations.map((path) => `  - ${relative(repoRoot, path)}`).join('\n');
  throw new Error(
    `[standalone-trace] Backup-, Quell- oder Build-Konfigurationsdateien wurden getraced:\n${details}`,
  );
}

console.log(
  `[standalone-trace] OK: ${manifest.files.length} Dateien, keine Backup-/Quellbaum-Leaks, ` +
    `${fontManifest.fonts.length} PDF-Schriften serverseitig im Standalone-Paket.`,
);
