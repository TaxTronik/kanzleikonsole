import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import nextPlugin from '@next/eslint-plugin-next';

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
      'no-restricted-syntax': [
        'error',
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
      ],
    },
  },
  {
    files: ['apps/web/src/server/auth/rbac.ts'],
    rules: {
      'no-restricted-syntax': 'off',
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
