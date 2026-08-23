import type { TxClient } from '@taxtronik/db';

export interface DraftInvoiceArchiveRef {
  id: string;
  tenantId: string;
  clientId: string;
  number: string;
  status: string;
  format: string;
  sentAt: Date | null;
  documentId: string | null;
  xrechnungDocumentId: string | null;
}

/**
 * Löst App-generierte Kontrollarchive eines nie versendeten Entwurfs und
 * blendet sie nachvollziehbar aus. Die Object-Lock-Versionen bleiben physisch
 * erhalten. Hochgeladene EXTERNAL/PDF-Belege werden ausdrücklich nie berührt.
 */
export async function discardNeverSentDraftArchiveTx(
  tx: TxClient,
  invoice: DraftInvoiceArchiveRef,
  staffId: string,
  reason = 'Nie versendeter Rechnungsentwurf wurde storniert.',
): Promise<{ documentIds: string[]; discardedAt: Date } | null> {
  if (invoice.status !== 'DRAFT' || invoice.sentAt !== null || invoice.format === 'PDF') {
    return null;
  }

  const documentIds = new Set<string>();
  if (invoice.documentId) documentIds.add(invoice.documentId);
  if (invoice.xrechnungDocumentId) documentIds.add(invoice.xrechnungDocumentId);
  if (documentIds.size === 0) return null;

  const detached = await tx.invoice.updateMany({
    where: {
      id: invoice.id,
      status: 'DRAFT',
      documentId: invoice.documentId,
      xrechnungDocumentId: invoice.xrechnungDocumentId,
    },
    data: { documentId: null, xrechnungDocumentId: null },
  });
  if (detached.count !== 1) {
    throw new Error('Rechnungsentwurf wurde während der Archivbereinigung geändert.');
  }

  const discardedAt = new Date();
  await tx.document.updateMany({
    where: { id: { in: [...documentIds] }, tenantId: invoice.tenantId, deletedAt: null },
    data: {
      deletedAt: discardedAt,
      deletedByStaff: staffId,
      deleteReason: reason,
      sharedWithClientAt: null,
      sharedByStaff: null,
    },
  });
  return { documentIds: [...documentIds], discardedAt };
}
