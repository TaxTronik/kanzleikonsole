import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests (Mapping, Resilience, Client mit injiziertem fetch) —
    // keine DB, kein Netzwerk und keine ENV: die Risk-Layer-Konfiguration wird
    // erst beim Aufruf gelesen (getRiskLayerConfig), nicht beim Import.
    pool: 'forks',
  },
});
