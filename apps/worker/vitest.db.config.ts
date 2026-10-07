import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import { DB_SUITE_GLOB, isolatedDbSuitesOf } from '../../scripts/ci/db-suites.mjs';
import base from './vitest.config';

// B-02: Glob-Lauf aller PostgreSQL-Suiten des Pakets (`pnpm --filter
// @taxtronik/worker run test:db`, db-CI-Job mit DB_TESTS=1) statt einer
// Dateiliste im Workflow. Der Unit-Lauf (`test`) schließt dieselben Dateien
// aus (scripts/ci/db-suites.mjs). Die Suiten teilen eine Datenbank und laufen
// nacheinander.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [DB_SUITE_GLOB],
      exclude: [...configDefaults.exclude, ...isolatedDbSuitesOf('apps/worker')],
      fileParallelism: false,
    },
  }),
);
