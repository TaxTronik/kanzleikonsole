import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reine Unit-Tests — bullmq/Redis/Prisma werden vollständig gemockt
    // (siehe src/jobs/__tests__/mocks), kein Infrastruktur-Setup nötig.
    pool: 'forks',
  },
});
