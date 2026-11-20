import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Wie apps/web und packages/config: In CI laufen alle Jobs parallel und
    // teilen sich die Runner-CPU; die Vitest-Vorgabe von 5 s riss dort Tests,
    // die allein rund 2 s brauchen (Lauf 1263/1267, 2026-11-20).
    testTimeout: 20_000,
    pool: 'forks',
  },
});
