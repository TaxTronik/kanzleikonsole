import type { TxClient } from '@taxtronik/db';

/** INV-LIFECYCLE-FREEZE-001: only the winning payment writes paidAt and audit. */
export async function claimInvoicePayment(
  tx: TxClient,
  tenantId: string,
  invoiceId: string,
  paidAt = new Date(),
) {
  const claimed = await tx.invoice.updateMany({
    where: { id: invoiceId, tenantId, status: { in: ['SENT', 'OVERDUE'] } },
    data: { status: 'PAID', paidAt },
  });
  if (claimed.count !== 1) return null;
  return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}
