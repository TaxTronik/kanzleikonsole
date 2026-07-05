import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests (Client mit injiziertem fetch) — keine DB, kein
    // Netzwerk, keine Bridge. setup-env.ts stellt die von @taxtronik/config
    // beim Import verlangte Minimal-ENV bereit.
    pool: 'forks',
    setupFiles: ['./src/__tests__/setup-env.ts'],
  },
});
