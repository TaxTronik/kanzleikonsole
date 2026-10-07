import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import { DB_SUITE_GLOB, isolatedDbSuitesOf } from '../../scripts/ci/db-suites.mjs';
import base from './vitest.config';

// B-02: Glob-Lauf aller PostgreSQL-Suiten des Pakets (`pnpm --filter
// @taxtronik/web run test:db`, db-CI-Job mit DB_TESTS=1) statt einer
// Dateiliste im Workflow. Der Unit-Lauf (`test`) schließt dieselben Dateien
// aus. Isolierte Suiten mit eigener Datenbank laufen in einem eigenen Schritt
// (scripts/ci/db-suites.mjs). Die Suiten teilen eine Datenbank: nacheinander
// statt parallel, wie zuvor als einzelne Workflow-Schritte.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [DB_SUITE_GLOB],
      exclude: [...configDefaults.exclude, ...isolatedDbSuitesOf('apps/web')],
      fileParallelism: false,
    },
  }),
);
