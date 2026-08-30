import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // Next erhält JSX im Build; SSR-Komponententests brauchen direkt ausführbares JSX.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Reine Unit-Tests — keine DB, kein Setup nötig
    pool: 'forks',
    exclude: [...configDefaults.exclude, '**/.next/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
