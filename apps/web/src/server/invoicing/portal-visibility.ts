import type { Prisma } from '@prisma/client';

/**
 * Fachkatalog INV-PORTAL-SHARING-001:
 * Entwuerfe und nie versendete Storni bleiben kanzleiintern. Ein versendeter
 * Beleg bleibt dagegen auch nach dem Storno als historischer Beleg sichtbar.
 */
export function portalInvoiceVisibilityWhere(clientId: string): Prisma.InvoiceWhereInput {
  return {
    clientId,
    OR: [
      { status: { in: ['SENT', 'PAID', 'OVERDUE'] } },
      { status: 'CANCELLED', sentAt: { not: null } },
    ],
  };
}
