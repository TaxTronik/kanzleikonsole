// Fachkatalog: POA-LIFECYCLE-001
// Review-Finding K-03: PostgreSQL-Nachweis der Vollmachten-Services.
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'Vollmachten-Services: PostgreSQL-Nachweis im CI',
  'apps/web/src/server/poa/__tests__/poa-services-db.test.ts',
  'POA_SERVICE_DB_TEST',
);
