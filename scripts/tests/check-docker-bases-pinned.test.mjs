import assert from 'node:assert/strict';
import {
  buildContextCopySources,
  checkBuildContextCopySources,
  checkBuildContextImports,
  checkBuilderSourcePermissions,
  checkDockerfiles,
  checkDockerignore,
  checkRequiredComposeSecrets,
  checkRuntimePackageManagersRemoved,
  checkSharedBaseNotOverridden,
  checkSharedNodeBase,
  checkWebRuntimeDockerfile,
  ignoredByDockerignore,
  relativeImportSpecifiers,
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
// Globaler ARG mit gepinntem Default traegt die Basis; ungepinnter Default oder
// ein erst nach dem ersten FROM deklarierter ARG zaehlen als ungepinnt.
const sharedBase = `node:24-alpine3.23@sha256:${digest}`;
const sharedDockerfile = [
  `ARG NODE_BASE_IMAGE=${sharedBase}`,
  'FROM ${NODE_BASE_IMAGE} AS builder',
  'FROM ${NODE_BASE_IMAGE} AS runner',
].join('\n');
assert.equal(checkDockerfiles([{ name: 'Dockerfile', source: sharedDockerfile }]), true);
assert.deepEqual(
  unpinnedFromLines('ARG NODE_BASE_IMAGE=node:24-alpine\nFROM $NODE_BASE_IMAGE AS b', 'D'),
  ['D:2: FROM $NODE_BASE_IMAGE AS b (= FROM node:24-alpine AS b)'],
);
assert.throws(
  () =>
    checkDockerfiles([
      {
        name: 'Dockerfile',
        source: `FROM scratch AS seed\nARG NODE_BASE_IMAGE=${sharedBase}\nFROM \${NODE_BASE_IMAGE}`,
      },
    ]),
  /Dockerfile:3: FROM \$\{NODE_BASE_IMAGE\}/,
);
assert.equal(
  checkSharedNodeBase([
    { name: 'Dockerfile.web', source: sharedDockerfile },
    { name: 'Dockerfile.worker', source: sharedDockerfile },
  ]),
  true,
);
assert.throws(
  () =>
    checkSharedNodeBase([
      { name: 'Dockerfile.web', source: sharedDockerfile },
      { name: 'Dockerfile.worker', source: sharedDockerfile.replace(digest, 'b'.repeat(64)) },
    ]),
  /dieselbe Basis/,
);
assert.throws(
  () =>
    checkSharedNodeBase([
      {
        name: 'Dockerfile.worker',
        source: sharedDockerfile.replace(
          'FROM ${NODE_BASE_IMAGE} AS runner',
          `FROM ${sharedBase} AS runner`,
        ),
      },
    ]),
  /Stage runner muss FROM \$\{NODE_BASE_IMAGE\} AS runner sein/,
);
assert.throws(
  () => checkSharedNodeBase([{ name: 'Dockerfile.web', source: 'FROM node:24 AS builder' }]),
  /ARG NODE_BASE_IMAGE=/,
);
assert.equal(checkSharedBaseNotOverridden([{ name: 'ci.yml', source: 'build-args: |' }]), true);
assert.throws(
  () =>
    checkSharedBaseNotOverridden([
      { name: 'release.yml', source: 'build-args: |\n  NODE_BASE_IMAGE=node:24' },
    ]),
  /release\.yml/,
);
assert.equal(checkDockerignore(REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS.join('\n')), true);
assert.throws(
  () =>
    checkDockerignore(
      REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS.filter((entry) => entry !== '**/.next').join('\n'),
    ),
  /\*\*\/\.next/,
);
assert.throws(
  () =>
    checkDockerignore(
      REQUIRED_RECURSIVE_DOCKERIGNORE_PATTERNS.filter((entry) => entry !== '.codex-run').join('\n'),
    ),
  /\.codex-run/,
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
const normalizedBuilder = [
  'FROM node:24 AS builder',
  'WORKDIR /repo',
  'COPY . .',
  'RUN chmod -R u=rwX,go=rX /repo',
  'FROM node:24 AS runner',
].join('\n');
assert.equal(checkBuilderSourcePermissions(normalizedBuilder), true);
assert.throws(
  () =>
    checkBuilderSourcePermissions(
      normalizedBuilder.replace('RUN chmod -R u=rwX,go=rX /repo\n', ''),
    ),
  /chmod -R u=rwX,go=rX/,
);
assert.throws(
  () => checkBuilderSourcePermissions(normalizedBuilder.replace('u=rwX,go=rX', 'a+rX')),
  /nicht gruppen-\/welt-schreibbar/,
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

// Build-Kontext-Quellen: nach T-02 brach `COPY patches ./patches` beide
// Image-Builds, weil der Ordner nicht mehr existierte.
const present = new Set(['package.json', 'pnpm-lock.yaml', '.npmrc', 'docs/guide.md', 'apps/web']);
const exists = (path) => present.has(path);
const contextDockerfile = [
  `FROM node:24-alpine@sha256:${digest} AS builder`,
  'COPY package.json ./',
  'COPY pnpm-lock.yaml ./.npmrc ./',
  'COPY . .',
  `FROM node:24-alpine@sha256:${digest} AS runner`,
  'COPY --from=builder /repo/apps/web/.next/standalone ./',
  'COPY --chown=node:node ["apps/web", "/app/web"]',
  'COPY <<EOF /etc/motd',
].join('\n');
assert.deepEqual(
  buildContextCopySources(contextDockerfile).map(({ line, path }) => `${line}:${path}`),
  ['2:package.json', '3:pnpm-lock.yaml', '3:.npmrc', '4:.', '7:apps/web'],
);
assert.equal(
  checkBuildContextCopySources([{ name: 'Dockerfile', source: contextDockerfile }], {
    exists,
    dockerignore: '',
  }),
  true,
);
assert.throws(
  () =>
    checkBuildContextCopySources([{ name: 'Dockerfile.web', source: 'COPY patches ./patches' }], {
      exists,
      dockerignore: '',
    }),
  /Dockerfile\.web:1: patches fehlt im Repository/,
);
assert.throws(
  () =>
    checkBuildContextCopySources([{ name: 'Dockerfile', source: 'COPY docs/guide.md ./' }], {
      exists,
      dockerignore: '# Doku\n/docs\n',
    }),
  /Dockerfile:1: docs\/guide\.md ist per \.dockerignore ausgeschlossen/,
);
// Fortsetzungszeilen zaehlen ab der COPY-Zeile; `!` nimmt einen Ausschluss zurueck.
assert.equal(
  checkBuildContextCopySources(
    [{ name: 'Dockerfile', source: 'RUN true\nCOPY package.json \\\n  docs/guide.md ./' }],
    { exists, dockerignore: '/docs\n!docs/guide.md\n' },
  ),
  true,
);
assert.throws(
  () =>
    checkBuildContextCopySources(
      [{ name: 'Dockerfile', source: 'RUN true\nCOPY package.json \\\n  missing.txt ./' }],
      { exists, dockerignore: '' },
    ),
  /Dockerfile:2: missing\.txt fehlt im Repository/,
);
assert.equal(ignoredByDockerignore('apps/web/node_modules/x', ['**/node_modules']), true);
assert.equal(ignoredByDockerignore('node_modules', ['**/node_modules']), true);
assert.equal(ignoredByDockerignore('apps/web/install.log', ['*.log']), false);
assert.equal(ignoredByDockerignore('install.log', ['*.log']), true);
assert.equal(ignoredByDockerignore('apps/web/vitest.db.config.ts', ['**/vitest*.config.ts']), true);

// Build-Kontext-Importe: apps/web/vitest.db.config.ts importierte aus dem per
// .dockerignore ausgeschlossenen /scripts; `next build` brach im Image mit TS2307 ab.
assert.deepEqual(
  relativeImportSpecifiers(
    [
      "import a from './a';",
      'export * from "../b";',
      "import './c.css';",
      "const d = await import('./d');",
      "import e from 'e';",
      "import f from '@/f';",
    ].join('\n'),
  ),
  ['./a', '../b', './c.css', './d'],
);
const webFiles = new Set(['apps/web/src/a.ts', 'apps/web/src/lib/index.ts', 'scripts/ci/x.mjs']);
const webExists = (path) => webFiles.has(path);
assert.throws(
  () =>
    checkBuildContextImports(
      [
        {
          name: 'apps/web/vitest.db.config.ts',
          source: "import { X } from '../../scripts/ci/x.mjs';",
        },
      ],
      { exists: webExists, dockerignore: '/scripts\n' },
    ),
  /apps\/web\/vitest\.db\.config\.ts: \.\.\/\.\.\/scripts\/ci\/x\.mjs -> scripts\/ci\/x\.mjs/,
);
// Ausgeschlossene Importeure, aufgeloeste Endungen und index-Dateien sowie die
// im Image erzeugten Next-Routentypen sind zulaessig.
assert.equal(
  checkBuildContextImports(
    [
      { name: 'apps/web/vitest.db.config.ts', source: "import '../../scripts/ci/x.mjs';" },
      { name: 'apps/web/src/b.ts', source: "import a from './a';\nimport l from './lib';" },
      { name: 'apps/web/next-env.d.ts', source: 'import "./.next/types/routes.d.ts";' },
    ],
    { exists: webExists, dockerignore: '/scripts\n**/vitest*.config.ts\n**/.next\n' },
  ),
  true,
);
assert.throws(
  () =>
    checkBuildContextImports(
      [{ name: 'apps/web/src/b.ts', source: "import h from './__tests__/helper';" }],
      { exists: () => false, dockerignore: '**/__tests__\n' },
    ),
  /apps\/web\/src\/b\.ts: \.\/__tests__\/helper -> apps\/web\/src\/__tests__\/helper/,
);
assert.throws(
  () =>
    checkBuildContextImports([{ name: 'apps/web/x.ts', source: "import '../../../outside';" }], {
      exists: () => false,
      dockerignore: '',
    }),
  /apps\/web\/x\.ts: \.\.\/\.\.\/\.\.\/outside -> \.\.\/outside/,
);

process.stdout.write('42 Docker base/context/runtime/compose tests passed.\n');
