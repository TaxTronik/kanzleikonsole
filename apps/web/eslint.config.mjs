// =============================================================================
// ESLint flat config — taxtronik web
//
// Minimal: erbt Next.js-Defaults und ergänzt projektspezifische Regeln,
// die echte Re-Review-Befunde verhindern (siehe N2).
// =============================================================================

import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      // N2: RBAC-Konsolidierung — alle Admin-Checks müssen `isStaffAdmin`
      // aus `@/server/auth/rbac` verwenden. Inline-roles?.some-Checks oder
      // lokale `requireAdmin(roles)`-Helper sind verboten, weil sie bei
      // Rollen-Änderungen (z. B. neue Rolle "GWG_OFFICER") synchron
      // angepasst werden müssten und dabei Drift entsteht.
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
];
