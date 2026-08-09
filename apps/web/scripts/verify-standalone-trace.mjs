import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const forbiddenStandaloneFiles = [
  ...regularFilesBelow(resolve(standaloneRoot, 'backups')),
  ...regularFilesBelow(resolve(standaloneRoot, 'apps/web/src')).filter((path) =>
    ['.ts', '.tsx'].includes(extname(path)),
  ),
];

const violations = [...new Set([...forbiddenTraceEntries, ...forbiddenStandaloneFiles])];
if (violations.length > 0) {
  const details = violations.map((path) => `  - ${relative(repoRoot, path)}`).join('\n');
  throw new Error(
    `[standalone-trace] Backup-, Quell- oder Build-Konfigurationsdateien wurden getraced:\n${details}`,
  );
}

console.log(
  `[standalone-trace] OK: ${manifest.files.length} Dateien, keine Backup-/Quellbaum-Leaks.`,
);
