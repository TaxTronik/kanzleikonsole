import { defineConfig } from 'vitest/config';

// Vertragstest gegen eine laufende TCMS-API (TCMS_CONTRACT_TESTS=1, Anleitung im
// Kopf der Testdatei und in docs/development/tcms-anbindung.md).
export default defineConfig({
  test: {
    pool: 'forks',
    include: ['src/**/*.contract.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
