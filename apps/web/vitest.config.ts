import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // Next erhält JSX im Build; SSR-Komponententests brauchen direkt ausführbares JSX.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Reine Unit-Tests — keine DB. Standardumgebung bleibt Node; Render- und
    // Verhaltenstests mit DOM wählen jsdom je Datei per Kopfkommentar
    // `// @vitest-environment jsdom` (B-08). Das Setup räumt dort nach jedem
    // Test auf und lädt in Node-Dateien nichts.
    pool: 'forks',
    // CI führt mehrere Jobs gleichzeitig auf einem Runner-Host aus; repo-weite
    // Quelltextprüfungen und erschöpfende Schleifen brauchen dort 2-5 s statt
    // lokal 1-2 s (Lauf 3908: kontrollbuch-seite nach 5,3 s abgebrochen).
    // 20 s lassen genug Reserve und beenden einen hängenden Test trotzdem.
    testTimeout: 20_000,
    exclude: [...configDefaults.exclude, '**/.next/**'],
    setupFiles: ['./src/__tests__/dom-setup.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
