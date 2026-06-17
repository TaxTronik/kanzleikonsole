import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
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
      '**/*.tsbuildinfo',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
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
      // Einzelfälle (z. B. ASN.1-Parsing) können via eslint-disable gerechtfertigt werden.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
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
      '@next/next': nextPlugin,
    },
    settings: {
      next: {
        rootDir: 'apps/web/',
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      // eslint-plugin-react-hooks v7 bringt React-Compiler-Regeln (purity,
      // set-state-in-effect, refs, immutability) mit. Diese sind für eine
      // schrittweise Migration gedacht — aktuell zu viele Bestands-Treffer.
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
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
