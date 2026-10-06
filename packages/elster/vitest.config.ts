import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests (Client mit injiziertem fetch) — keine DB, kein
    // Netzwerk, keine Bridge und keine ENV: die Bridge-Konfiguration wird erst
    // beim Aufruf gelesen (getElsterConfig), nicht beim Import.
    pool: 'forks',
  },
});
