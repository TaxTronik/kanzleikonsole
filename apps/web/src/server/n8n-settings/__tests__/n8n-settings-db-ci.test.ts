// Fachkatalog: AUDIT-HASH-CHAIN-001
// Review-Finding K-03: PostgreSQL-Nachweis der n8n-Einstellungs-Services.
// B-02: Der db-Job findet die Suite per Glob (scripts/ci/db-suites.mjs) und führt
// sie mit DB_TESTS=1 aus; geprüft wird die Verdrahtung genau dieser Datei.
import { describeDbSuiteInCi } from '@/__tests__/db-suite-ci';

describeDbSuiteInCi(
  'n8n-Einstellungs-Services: PostgreSQL-Nachweis im CI',
  'apps/web/src/server/n8n-settings/__tests__/n8n-settings-db.test.ts',
  'N8N_SETTINGS_DB_TEST',
);
