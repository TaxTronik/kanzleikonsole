import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import nextPlugin from '@next/eslint-plugin-next';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// isStaffAdmin statt Rollen-Literalen; gilt für alle TS-Dateien.
const ROLE_CHECK_SELECTORS = [
  {
    selector:
      "CallExpression[callee.property.name='some'] > ArrowFunctionExpression > LogicalExpression > BinaryExpression[right.value='ADMIN']",
    message:
      'Verwende isStaffAdmin(session) aus @/server/auth/rbac statt session.user.roles?.some(...).',
  },
  {
    selector:
      "CallExpression[callee.property.name='some'] > ArrowFunctionExpression > LogicalExpression > BinaryExpression[right.value='PARTNER']",
    message:
      'Verwende isStaffAdmin(session) aus @/server/auth/rbac statt session.user.roles?.some(...).',
  },
];

// Schichtgrenze (Review-Befund K-08): Routenordner (app/) bauen auf components/
// und server/ auf, nie umgekehrt. Geteilte UI liegt in components/<feature>,
// Server-Actions kommen als Props oder aus server/<feature>/actions. Geprüft
// werden statische Importe und Re-Exporte sowie dynamische import()-Aufrufe;
// Tests sind ausgenommen.
const APP_LAYER_MESSAGE =
  'components/ und server/ importieren nicht aus app/. Geteilte UI nach components/<feature>, Server-Actions als Props übergeben oder nach server/<feature>/actions legen (K-08).';

/**
 * Begründete Ausnahmen der Schichtgrenze: Dateien und die app-Module, die sie
 * importieren dürfen. Fällt ein Import weg, wird der Eintrag gelöscht
 * (apps/web/src/__tests__/app-layer-imports.test.ts prüft das).
 */
export const APP_LAYER_ALLOWLIST = [
  {
    // Dokumentaktionen werden parallel umgebaut (Uploads, Sammelaktionen);
    // documents/actions.ts ist zudem code_ref von DOC-PORTAL-SHARING-001 und
    // DOC-VERSION-IMMUTABILITY-001. Ziel: Actions als Props oder server/documents.
    files: [
      'apps/web/src/components/document-dialogs.tsx',
      'apps/web/src/components/document-explorer/browser-view.tsx',
      'apps/web/src/components/document-explorer/delete-dialog.tsx',
      'apps/web/src/components/document-explorer/embedded-view.tsx',
      'apps/web/src/components/document-explorer/ops.tsx',
    ],
    modules: ['staff/(protected)/documents/actions', 'staff/(protected)/documents/folder-actions'],
  },
  {
    // NewRequestForm ist code_ref von REQ-LIFECYCLE-001 und wird hier per
    // next/dynamic erst beim Öffnen geladen (P-25). Ziel: components/requests.
    files: ['apps/web/src/components/quick-request-dialog.tsx'],
    modules: ['staff/(protected)/clients/[id]/requests/new/form'],
  },
  {
    // Planungsvergleich und Plan↔Hochrechnung sind code_refs von
    // BWA-PROJECTION-001 unter app/portal. Ziel: components/bwa.
    files: ['apps/web/src/components/bwa/bwa-dashboard.tsx'],
    modules: [
      'portal/(protected)/bwa/plan/plan-comparison',
      'portal/(protected)/bwa/plan/plan-vs-projection',
    ],
  },
];

// ENV-Profile (Review-Befund K-09): Worker und CLI-Skripte wählen ihr Profil
// (packages/config/src/env-schema.ts) mit dem ERSTEN Import ihres Einstiegs-
// moduls. Nur dann steht die Wahl vor jeder Auswertung von @taxtronik/config;
// sonst validiert der Prozess das Web-Profil (und die Wahl scheitert beim Start).
export const ENV_PROFILE_ENTRIES = [
  { file: 'apps/worker/src/index.ts', profile: 'worker' },
  { file: 'packages/db/scripts/rewrap-secret-box.ts', profile: 'cli-secret-box' },
  { file: 'packages/storage/scripts/deploy-readiness.ts', profile: 'cli-storage' },
];

// Paketgrenze (Review-Befund K-01): @taxtronik/gwg enthält GwG-Regeln mit
// tx-Signatur für Web UND Worker. Next.js, React und Web-Module (`@/`, apps/)
// bleiben draußen; Autorisierung, Audit/Evidence und Storage verdrahtet der
// Web-Adapter in apps/web/src/server/gwg.
const GWG_PACKAGE_MESSAGE =
  '@taxtronik/gwg importiert weder Next.js/React noch Web-Module (@/, apps/); Autorisierung, Audit und Storage verdrahtet der Adapter in apps/web/src/server/gwg (K-01).';

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regelkonfiguration der Schichtgrenze, ohne die erlaubten Module (`@/app/<modul>`). */
function appLayerRules(allowed = []) {
  const ausnahme = allowed.length ? `(?!(?:${allowed.map(escapeRegExp).join('|')})$)` : '';
  // esquery-Regex dürfen keinen Schrägstrich enthalten: \u002F statt '/'.
  const dynamisch = `^@\\u002Fapp\\u002F${ausnahme.replaceAll('/', '\\u002F')}`;
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { regex: `^@/app/${ausnahme}`, message: APP_LAYER_MESSAGE },
          { regex: '^(?:\\.\\./)+app/', message: APP_LAYER_MESSAGE },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...ROLE_CHECK_SELECTORS,
      { selector: `ImportExpression > Literal[value=/${dynamisch}/]`, message: APP_LAYER_MESSAGE },
    ],
  };
}

// Oberflächengrenze (Review-Befund K-08): Staff-Seiten importieren keine Module
// aus app/portal; gemeinsame UI liegt in components/<feature>. Geprüft wird das
// Ziel statischer, Typ-, Re-Export- und dynamischer Importe, über den Alias
// und über relative Pfade; Tests sind ausgenommen.
const STAFF_PORTAL_MESSAGE =
  'Staff-Seiten importieren nicht aus app/portal. Gemeinsame UI nach components/<feature> legen (K-08).';

/**
 * Begründete Ausnahmen der Oberflächengrenze: Dateien und die Portal-Module
 * (`@/app/<modul>`), die sie importieren dürfen. Fällt ein Import weg, wird der
 * Eintrag gelöscht (apps/web/src/__tests__/app-layer-imports.test.ts prüft das).
 */
export const STAFF_PORTAL_ALLOWLIST = [
  {
    // Der Plan-Assistent ist code_ref von BWA-IMPORT-MAPPING-001 unter
    // app/portal. Ziel: components/bwa.
    files: ['apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/new/page.tsx'],
    modules: ['portal/(protected)/bwa/plan/plan-wizard'],
  },
];

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'apps/web/src/app');

/** Dateipfad als Glob ohne Sonderzeichen: (protected) und [id] wörtlich. */
const literalGlob = (file) => file.replace(/[()[\]{}*?!+@]/g, '\\$&');

/** Ziel eines Imports relativ zu apps/web/src/app, `null` außerhalb davon. */
function appZiel(filename, specifier) {
  if (specifier.startsWith('@/app/')) return specifier.slice('@/app/'.length);
  if (!specifier.startsWith('.')) return null;
  const ziel = relative(APP_DIR, resolve(dirname(filename), specifier));
  return ziel.startsWith('..') || isAbsolute(ziel) ? null : ziel.split(sep).join('/');
}

const surfacePlugin = {
  rules: {
    'no-portal-import': {
      meta: {
        type: 'problem',
        schema: [{ type: 'array', items: { type: 'string' } }],
        messages: { portal: STAFF_PORTAL_MESSAGE },
      },
      create(context) {
        const erlaubt = new Set(context.options[0] ?? []);
        const pruefe = (source) => {
          if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
          const ziel = appZiel(context.filename, source.value);
          if ((ziel === 'portal' || ziel?.startsWith('portal/')) && !erlaubt.has(ziel)) {
            context.report({ node: source, messageId: 'portal' });
          }
        };
        return {
          ImportDeclaration: (node) => pruefe(node.source),
          ExportNamedDeclaration: (node) => pruefe(node.source),
          ExportAllDeclaration: (node) => pruefe(node.source),
          ImportExpression: (node) => pruefe(node.source),
        };
      },
    },
  },
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      // Reproducibly copied third-party workers/WASM loaders; source stays in node_modules.
      'apps/web/public/identity-assets/**',
      '**/*.tsbuildinfo',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.codex-run/**',
      '.VSCodeCounter/**',
      'DEMODATEN/**',
      'infra/compose/.volumes/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Guardrail für künftige Beiträge: `any` wird als Fehler gewertet.
      // Einzelfälle (z. B. ASN.1-Parsing) können via eslint-disable gerechtfertigt werden.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Neue Treffer blockieren. Die bestehende Komplexitätsschuld steht je
      // Datei als Zähler in eslint-suppressions.json (ESLint-Bulk-Suppressions):
      // mehr Treffer als erfasst schlagen fehl, weniger verlangen
      // `pnpm lint:prune-suppressions`. Die Zähler können so nur sinken.
      complexity: ['error', 20],
      'no-restricted-syntax': ['error', ...ROLE_CHECK_SELECTORS],
    },
  },
  {
    files: ['apps/web/src/components/**/*.{ts,tsx}', 'apps/web/src/server/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    rules: appLayerRules(),
  },
  ...APP_LAYER_ALLOWLIST.map(({ files, modules }) => ({
    files: files.map(literalGlob),
    rules: appLayerRules(modules),
  })),
  ...ENV_PROFILE_ENTRIES.map(({ file, profile }) => ({
    files: [file],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ROLE_CHECK_SELECTORS,
        {
          selector: `Program > :first-child:not(ImportDeclaration[source.value='@taxtronik/config/profiles/${profile}'])`,
          message: `Erster Import muss '@taxtronik/config/profiles/${profile}' sein: das ENV-Profil wirkt nur vor jeder Auswertung von @taxtronik/config (K-09).`,
        },
      ],
    },
  })),
  {
    files: ['apps/web/src/app/staff/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}'],
    plugins: { surface: surfacePlugin },
    rules: { 'surface/no-portal-import': 'error' },
  },
  ...STAFF_PORTAL_ALLOWLIST.map(({ files, modules }) => ({
    files: files.map(literalGlob),
    plugins: { surface: surfacePlugin },
    rules: { 'surface/no-portal-import': ['error', modules] },
  })),
  {
    files: ['apps/web/src/server/auth/rbac.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['packages/gwg/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?:next|react|react-dom|server-only)(?:/|$)', message: GWG_PACKAGE_MESSAGE },
            { regex: '^@/', message: GWG_PACKAGE_MESSAGE },
            { regex: '^(?:\\.\\./)+apps/', message: GWG_PACKAGE_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
      '@next/next': nextPlugin,
    },
    settings: {
      next: {
        rootDir: 'apps/web/',
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      // Fokus wird in mehrstufigen Login- und Dialog-Flows bewusst gesetzt
      // und durch eigene Fokus-Rückgabe-/Fokusfallen-Tests abgesichert. Ein
      // pauschales Autofokus-Verbot würde diese Tastaturführung verschlechtern.
      'jsx-a11y/no-autofocus': 'off',
      // Scrollbare Listen ohne interaktive Kinder benötigen gemäß Axe einen
      // eigenen Tastaturfokus, damit sie insbesondere in Safari scrollbar
      // bleiben. Nur das semantische Listenelement wird dafür freigegeben.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { tags: ['ul'] }],
      // React-Compiler-Regeln blockieren direkt. Die frühere Warnungs-Baseline
      // stand für jede Regel auf null; ein separates Gate ist nicht mehr nötig.
      'react-hooks/purity': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/static-components': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
];
