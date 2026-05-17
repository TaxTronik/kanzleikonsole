import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests für ENV-Validierung — kein DB-/Netzwerk-Setup nötig.
    pool: 'forks',
  },
});
