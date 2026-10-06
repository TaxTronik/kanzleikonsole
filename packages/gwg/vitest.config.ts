import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests (Fristen, Eskalationsstufen, Lebenszyklus mit Tx-Attrappe);
    // die PostgreSQL-Nachweise laufen in packages/db und apps/web (db-Job).
    pool: 'forks',
  },
});
