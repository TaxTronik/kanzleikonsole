import type { TxClient } from '@taxtronik/db';

/** Serialisiert Archiv-Link, finalen Versand-Claim und Entwurfsstorno. */
export async function lockInvoiceArchiveTx(tx: TxClient, invoiceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'invoice-archive:' + invoiceId}, 0))`;
}
