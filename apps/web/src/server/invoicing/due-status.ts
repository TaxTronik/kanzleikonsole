import type { Invoice } from '@prisma/client';

/** INV-DUE-OVERDUE-001: Vorschau des täglichen Statuswechsels für Originalrechnungen. */
export function isSentInvoicePastDue(
  invoice: Pick<Invoice, 'status' | 'stornoOfId' | 'dueDate'>,
  today: Date,
): boolean {
  return invoice.status === 'SENT' && invoice.stornoOfId === null && invoice.dueDate < today;
}
