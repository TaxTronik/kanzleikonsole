import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sequenziell — RLS-Tests dürfen nicht parallel laufen (teilen eine DB).
    pool: 'forks',
    forks: { singleFork: true },
    timeout: 30_000,
  },
});
