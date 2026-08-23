import { describe, expect, it, vi } from 'vitest';
import { discardNeverSentDraftArchiveTx } from '../draft-archive';

function transaction() {
  return {
    invoice: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    document: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
}

const draft = {
  id: 'invoice-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  number: '2026-0042',
  status: 'DRAFT',
  format: 'ZUGFERD',
  sentAt: null,
  documentId: 'pdf-doc',
  xrechnungDocumentId: 'xml-doc',
};

describe('discardNeverSentDraftArchiveTx', () => {
  it('löst PDF und XML eines nie versendeten Entwurfs und soft-deleted beide', async () => {
    const tx = transaction();
    const result = await discardNeverSentDraftArchiveTx(tx as never, draft, 'staff-1');

    expect(result?.documentIds).toEqual(['pdf-doc', 'xml-doc']);
    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'invoice-1',
        status: 'DRAFT',
        documentId: 'pdf-doc',
        xrechnungDocumentId: 'xml-doc',
      },
      data: { documentId: null, xrechnungDocumentId: null },
    });
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['pdf-doc', 'xml-doc'] },
        tenantId: 'tenant-1',
        deletedAt: null,
      },
      data: expect.objectContaining({
        deletedByStaff: 'staff-1',
        sharedWithClientAt: null,
        sharedByStaff: null,
      }),
    });
  });

  it('verändert einen extern hochgeladenen PDF-Beleg nicht', async () => {
    const tx = transaction();
    await expect(
      discardNeverSentDraftArchiveTx(
        tx as never,
        { ...draft, format: 'PDF', documentId: 'signed-external-pdf' },
        'staff-1',
      ),
    ).resolves.toBeNull();
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('blendet niemals ein nur gleichnamiges, aber unverknüpftes XML aus', async () => {
    const tx = transaction();
    const result = await discardNeverSentDraftArchiveTx(
      tx as never,
      { ...draft, documentId: null, xrechnungDocumentId: null },
      'staff-1',
    );

    expect(result).toBeNull();
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });
});
