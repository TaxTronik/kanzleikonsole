#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DIGEST = /@sha256:[0-9a-f]{64}(?:\s|$)/;
export const REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS = [
  '**/node_modules',
  '**/.next',
  '**/.turbo',
  '**/dist',
  '**/build',
  '**/out',
  '**/coverage',
  '/apps/web/backups',
  '.taxtronik.state',
  '.taxtronik.migration-pending',
  '.taxtronik.database-restored',
];
export const REQUIRED_COMPOSE_SECRETS = ['AUTH_SECRET', 'N8N_ENCRYPTION_KEY'];

export function unpinnedFromLines(source, fileName = '<Dockerfile>') {
  return source
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /^FROM\s+/i.test(line))
    .filter(({ line }) => !/^FROM\s+scratch(?:\s|$)/i.test(line))
    .filter(({ line }) => !DIGEST.test(line))
    .map(({ line, number }) => `${fileName}:${number}: ${line}`);
}

export function checkDockerfiles(files) {
  const findings = files.flatMap(({ name, source }) => unpinnedFromLines(source, name));
  if (findings.length > 0) {
    throw new Error(
      `Docker-Basisimages müssen unveränderlich per sha256-Digest gepinnt sein:\n${findings.join('\n')}`,
    );
  }
  return true;
}

export function checkDockerignore(source) {
  const entries = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
  const missing = REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS.filter(
    (pattern) => !entries.has(pattern),
  );
  if (missing.length > 0) {
    throw new Error(
      `.dockerignore muss Build-Artefakte und lokale Betriebsdaten ausschließen; fehlend: ${missing.join(', ')}`,
    );
  }
  return true;
}

export function checkRequiredComposeSecrets(source) {
  for (const secret of REQUIRED_COMPOSE_SECRETS) {
    const references = source.match(new RegExp(`\\$\\{${secret}(?::[^}]*)?\\}`, 'g')) ?? [];
    if (references.length === 0) {
      throw new Error(`Produktiv-Compose referenziert ${secret} nicht.`);
    }
    const unguarded = references.filter((reference) => !reference.startsWith(`\${${secret}:?`));
    if (unguarded.length > 0) {
      throw new Error(
        `Produktiv-Compose muss ${secret} per \${${secret}:?...} bereits bei der Interpolation erzwingen.`,
      );
    }
  }

  if (!source.includes('${N8N_LEGACY_CALLBACKS_ENABLED:-false}')) {
    throw new Error(
      'Produktiv-Compose muss N8N_LEGACY_CALLBACKS_ENABLED explizit mit Default false durchreichen.',
    );
  }
  const legacyWebhookReferences = source.match(/\$\{N8N_WEBHOOK_BASE_URL(?::[^}]*)?\}/g) ?? [];
  if (
    legacyWebhookReferences.length === 0 ||
    legacyWebhookReferences.some((reference) => reference !== '${N8N_WEBHOOK_BASE_URL:-}')
  ) {
    throw new Error(
      'Produktiv-Compose muss N8N_WEBHOOK_BASE_URL als default-leeren Legacy-Opt-in durchreichen.',
    );
  }
  const hmacReferences = source.match(/\$\{N8N_HMAC_SECRET(?::[^}]*)?\}/g) ?? [];
  if (hmacReferences.length === 0) {
    throw new Error(
      'Produktiv-Compose referenziert den optionalen N8N_HMAC_SECRET-Legacy-Fallback nicht.',
    );
  }
  if (hmacReferences.some((reference) => reference.startsWith('${N8N_HMAC_SECRET:?'))) {
    throw new Error(
      'Produktiv-Compose darf N8N_HMAC_SECRET bei default-off Legacy-Callbacks nicht global erzwingen.',
    );
  }
  return true;
}

export function checkWebRuntimeDockerfile(source) {
  if (!/^\s*HOSTNAME=0\.0\.0\.0\s*\\?\s*$/m.test(source)) {
    throw new Error(
      'Web-Runtime muss HOSTNAME=0.0.0.0 setzen, damit der Loopback-HEALTHCHECK den Standalone-Server erreicht.',
    );
  }
  if (!/^HEALTHCHECK[\s\S]*127\.0\.0\.1:3000\/api\/live/m.test(source)) {
    throw new Error('Web-Runtime braucht einen lokalen Docker-HEALTHCHECK gegen /api/live.');
  }
  return true;
}

export function checkRuntimePackageManagersRemoved(source, fileName = '<Dockerfile>') {
  const lastFrom = source.toLowerCase().lastIndexOf('\nfrom ');
  const runtime = lastFrom >= 0 ? source.slice(lastFrom) : source;
  for (const path of [
    '/usr/local/lib/node_modules/npm',
    '/usr/local/lib/node_modules/corepack',
    '/opt/yarn-',
  ]) {
    if (!runtime.includes(path)) {
      throw new Error(
        `${fileName}: ungenutzter Runtime-Paketmanager wird nicht entfernt (${path})`,
      );
    }
  }
  return true;
}

export function checkBuilderSourcePermissions(source, fileName = '<Dockerfile>') {
  const copyMatch = /^COPY\s+\.\s+\.\s*$/m.exec(source);
  if (!copyMatch) {
    throw new Error(`${fileName}: Builder muss den Workspace per COPY . . uebernehmen.`);
  }
  const afterCopy = copyMatch.index + copyMatch[0].length;
  const nextStageOffset = source.slice(afterCopy).search(/^FROM\s+/m);
  const builderTail = source.slice(
    afterCopy,
    nextStageOffset < 0 ? source.length : afterCopy + nextStageOffset,
  );
  if (!/^RUN\s+chmod\s+-R\s+a\+rX\s+\/repo\s*$/m.test(builderTail)) {
    throw new Error(
      `${fileName}: Builder muss Host-Modi nach COPY . . per chmod -R a+rX /repo fuer non-root Runtime-COPYs normalisieren.`,
    );
  }
  return true;
}

function main() {
  try {
    const directory = 'infra/docker';
    const names = readdirSync(directory)
      .filter((name) => name.startsWith('Dockerfile'))
      .sort();
    if (names.length === 0) throw new Error(`Keine Dockerfiles unter ${directory} gefunden.`);
    const files = names.map((name) => ({
      name: `${directory}/${name}`,
      source: readFileSync(`${directory}/${name}`, 'utf8'),
    }));
    checkDockerfiles(files);
    for (const file of files) {
      checkRuntimePackageManagersRemoved(file.source, file.name);
      checkBuilderSourcePermissions(file.source, file.name);
    }
    checkWebRuntimeDockerfile(readFileSync(`${directory}/Dockerfile.web`, 'utf8'));
    checkDockerignore(readFileSync('.dockerignore', 'utf8'));
    checkRequiredComposeSecrets(readFileSync('infra/compose/docker-compose.app.yml', 'utf8'));
    process.stdout.write(
      `OK: ${names.length} Dockerfiles verwenden nur digest-gepinnte Bases, normalisieren Builder-Quellmodi und entfernen Runtime-Paketmanager; Web-Liveness ist erreichbar, lokale Betriebsdaten sind ignoriert und produktive Compose-Secrets sind fail-closed.\n`,
    );
  } catch (error) {
    process.stderr.write(`FEHLER: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
