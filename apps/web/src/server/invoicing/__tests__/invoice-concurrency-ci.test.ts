// Fachkatalog: INV-LIFECYCLE-FREEZE-001
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'required invoice concurrency evidence in CI',
  'apps/web/src/server/invoicing/__tests__/invoice-concurrency-db.test.ts',
  'INVOICE_CONCURRENCY_DB_TEST',
);
