import type { TxClient } from '@taxtronik/db';

/** PostgreSQL returns void for advisory locks; do not ask Prisma to deserialize it. */
export async function lockFeeQuoteExportTx(
  tx: Pick<TxClient, '$executeRaw'>,
  quoteId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stbvv-export:${quoteId}`},0))`;
}
