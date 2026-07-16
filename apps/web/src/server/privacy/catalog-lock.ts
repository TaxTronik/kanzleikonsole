import type { TxClient } from '@taxtronik/db';

/** Serialisiert alle Änderungen der gerenderten Datenschutz-Anzeige pro Tenant. */
export async function lockConsentCatalogTx(tx: TxClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'privacy.consent_options:' + tenantId}::text, 0))`;
}
