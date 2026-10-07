// Fachkatalog: DOC-PORTAL-SHARING-001
// Review-Finding P-18: PostgreSQL-Nachweis der Dokument-Bulk-Actions.
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'Dokument-Bulk-Actions: PostgreSQL-Nachweis im CI',
  'apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions-db.test.ts',
  'DOCUMENT_BULK_DB_TEST',
);
