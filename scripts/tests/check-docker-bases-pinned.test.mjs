import assert from 'node:assert/strict';
import {
  checkDockerfiles,
  checkDockerignore,
  checkRequiredComposeSecrets,
  checkRuntimePackageManagersRemoved,
  checkWebRuntimeDockerfile,
  REQUIRED_COMPOSE_SECRETS,
  REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS,
  unpinnedFromLines,
} from '../check-docker-bases-pinned.mjs';

const digest = 'a'.repeat(64);

assert.equal(
  checkDockerfiles([
    { name: 'Dockerfile', source: `FROM node:24-alpine@sha256:${digest} AS build\nFROM scratch` },
  ]),
  true,
);
assert.deepEqual(unpinnedFromLines('FROM node:24-alpine AS build', 'Dockerfile'), [
  'Dockerfile:1: FROM node:24-alpine AS build',
]);
assert.throws(
  () => checkDockerfiles([{ name: 'Dockerfile', source: 'FROM node:24-alpine' }]),
  /sha256-Digest/,
);
assert.throws(
  () => checkDockerfiles([{ name: 'Dockerfile', source: 'FROM ${BASE_IMAGE}' }]),
  /FROM \$\{BASE_IMAGE\}/,
);
assert.equal(checkDockerignore(REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS.join('\n')), true);
assert.throws(
  () =>
    checkDockerignore(
      REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS.filter((entry) => entry !== '**/.next').join('\n'),
    ),
  /\*\*\/\.next/,
);
const webRuntime = [
  'ENV NODE_ENV=production \\',
  '    HOSTNAME=0.0.0.0 \\',
  '    PORT=3000',
  'HEALTHCHECK --interval=30s CMD wget --spider http://127.0.0.1:3000/api/live',
].join('\n');
assert.equal(checkWebRuntimeDockerfile(webRuntime), true);
assert.throws(
  () => checkWebRuntimeDockerfile(webRuntime.replace('    HOSTNAME=0.0.0.0 \\\n', '')),
  /HOSTNAME=0\.0\.0\.0/,
);
const minimizedRuntime = [
  'FROM node:24 AS builder',
  'RUN corepack enable',
  'FROM node:24 AS runner',
  'RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-*',
].join('\n');
assert.equal(checkRuntimePackageManagersRemoved(minimizedRuntime), true);
assert.throws(
  () => checkRuntimePackageManagersRemoved(minimizedRuntime.replace(' /opt/yarn-*', '')),
  /\/opt\/yarn-/,
);

const guardedComposeSecrets = [
  ...REQUIRED_COMPOSE_SECRETS.map((secret) => `${secret}: \${${secret}:?${secret} nicht gesetzt}`),
  "N8N_LEGACY_CALLBACKS_ENABLED: '${N8N_LEGACY_CALLBACKS_ENABLED:-false}'",
  'N8N_WEBHOOK_BASE_URL: ${N8N_WEBHOOK_BASE_URL:-}',
  'N8N_HMAC_SECRET: ${N8N_HMAC_SECRET:-}',
].join('\n');
assert.equal(checkRequiredComposeSecrets(guardedComposeSecrets), true);
assert.throws(
  () =>
    checkRequiredComposeSecrets(
      guardedComposeSecrets.replace('${AUTH_SECRET:?', '${AUTH_SECRET:-'),
    ),
  /AUTH_SECRET.*Interpolation erzwingen/,
);
assert.throws(
  () =>
    checkRequiredComposeSecrets(
      guardedComposeSecrets.replace(
        'N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY:?N8N_ENCRYPTION_KEY nicht gesetzt}',
        '',
      ),
    ),
  /N8N_ENCRYPTION_KEY nicht/,
);
assert.throws(
  () =>
    checkRequiredComposeSecrets(
      guardedComposeSecrets.replace('${N8N_LEGACY_CALLBACKS_ENABLED:-false}', 'false'),
    ),
  /N8N_LEGACY_CALLBACKS_ENABLED.*Default false/,
);
assert.throws(
  () =>
    checkRequiredComposeSecrets(
      guardedComposeSecrets.replace('${N8N_HMAC_SECRET:-}', '${N8N_HMAC_SECRET:?required}'),
    ),
  /N8N_HMAC_SECRET.*nicht global erzwingen/,
);
assert.throws(
  () =>
    checkRequiredComposeSecrets(
      guardedComposeSecrets.replace('${N8N_WEBHOOK_BASE_URL:-}', 'http://n8n:5678/webhook'),
    ),
  /N8N_WEBHOOK_BASE_URL.*default-leeren/,
);

process.stdout.write('16 Docker base/context/runtime/compose tests passed.\n');
