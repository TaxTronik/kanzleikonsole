// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001
// Fachkatalog: GWG-RISK-REVIEW-001
// K-03: PostgreSQL-Nachweis der GwG-Services.
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'GwG-Services: PostgreSQL-Nachweis im CI',
  'apps/web/src/server/gwg/__tests__/services-db.test.ts',
  'GWG_SERVICES_DB_TEST',
);
