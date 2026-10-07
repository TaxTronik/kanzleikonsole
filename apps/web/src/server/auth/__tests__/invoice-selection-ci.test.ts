// Fachkatalog: ACCESS-CLIENT-MODE-001
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'required invoice selection database evidence in CI',
  'apps/web/src/server/auth/__tests__/invoice-selection-db.test.tsx',
  'INVOICE_SELECTION_DB_TEST',
);
