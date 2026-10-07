// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-CLIENT-MODE-001
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'required settings atomicity database evidence in CI',
  'apps/web/src/server/settings/__tests__/settings-atomicity-db.test.ts',
  'SETTINGS_ATOMICITY_DB_TEST',
);
