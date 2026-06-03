import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
      // Guardrail für künftige Beiträge: `any` ist erlaubt, wird aber sichtbar
      // markiert (aktuell 0× im src) — hält die Typ-Disziplin, ohne den Build zu brechen.
      '@typescript-eslint/no-explicit-any': 'warn',
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
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
];
