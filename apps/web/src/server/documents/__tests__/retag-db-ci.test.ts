// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// Review-Finding K-03: PostgreSQL-Nachweis des Retag-Service.
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'Retag-Service: PostgreSQL-Nachweis im CI',
  'apps/web/src/server/documents/__tests__/retag-db.test.ts',
  'DOCUMENT_RETAG_DB_TEST',
);
