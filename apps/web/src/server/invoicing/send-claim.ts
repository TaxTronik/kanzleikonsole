import type { TxClient } from '@taxtronik/db';

const DELIVERED_STATUSES = new Set(['SENT', 'OVERDUE', 'PAID']);

/**
 * Atomarer DRAFT -> SENT-Claim mit expliziter Auflösung des CAS-Verlierers.
 * Ein verlorener Claim ist nur dann idempotenter Erfolg, wenn die Rechnung
 * tatsächlich bereits ausgeliefert wurde. CANCELLED und jeder andere Zustand
 * bleiben ein fachlicher Konflikt.
 */
export async function claimInvoiceDraftForSend(
  tx: TxClient,
  invoiceId: string,
  sentAt = new Date(),
) {
  const claimed = await tx.invoice.updateMany({
    where: { id: invoiceId, status: 'DRAFT' },
    data: { status: 'SENT', sentAt },
  });
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });

  if (!invoice) return { outcome: 'not_found' as const };
  if (claimed.count === 1) return { outcome: 'sent' as const, invoice };
  if (DELIVERED_STATUSES.has(invoice.status)) {
    return { outcome: 'already_sent' as const, invoice };
  }
  return { outcome: 'conflict' as const, status: invoice.status };
}
