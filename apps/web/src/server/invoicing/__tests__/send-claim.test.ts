import { describe, expect, it, vi } from 'vitest';
import { claimInvoiceDraftForSend } from '../send-claim';

function txWith(count: number, invoice: { status: string } | null) {
  return {
    invoice: {
      updateMany: vi.fn().mockResolvedValue({ count }),
      findUnique: vi.fn().mockResolvedValue(invoice),
    },
  };
}

describe('claimInvoiceDraftForSend', () => {
  it('meldet den eigenen erfolgreichen DRAFT-Claim als sent', async () => {
    const tx = txWith(1, { status: 'SENT' });
    const sentAt = new Date('2026-08-23T10:00:00.000Z');

    await expect(claimInvoiceDraftForSend(tx as never, 'invoice-1', sentAt)).resolves.toMatchObject(
      { outcome: 'sent', invoice: { status: 'SENT' } },
    );
    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'invoice-1', status: 'DRAFT' },
      data: { status: 'SENT', sentAt },
    });
  });

  it.each(['SENT', 'OVERDUE', 'PAID'])(
    'behandelt %s als idempotent bereits versendet',
    async (status) => {
      const tx = txWith(0, { status });
      await expect(claimInvoiceDraftForSend(tx as never, 'invoice-1')).resolves.toMatchObject({
        outcome: 'already_sent',
        invoice: { status },
      });
    },
  );

  it('meldet einen parallel gewonnenen Storno ausdrücklich als Konflikt', async () => {
    const tx = txWith(0, { status: 'CANCELLED' });
    await expect(claimInvoiceDraftForSend(tx as never, 'invoice-1')).resolves.toEqual({
      outcome: 'conflict',
      status: 'CANCELLED',
    });
  });
});
