import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { requireGwgReverificationTx, startFreshGwgReviewTx } from '../reverification';

describe('GwG-Wiederholungsprüfung', () => {
  it('entwertet VERIFIED-Snapshots, deaktiviert und erhält deren Aggregate', async () => {
    const tx = {
      gwgCheck: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ id: 'open-review' }),
        create: vi.fn(),
        deleteMany: vi.fn(),
      },
      gwgBeneficialOwner: { deleteMany: vi.fn() },
      gwgIdDocument: { deleteMany: vi.fn() },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    const result = await requireGwgReverificationTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: 'VERIFIED' },
      data: { status: 'EXPIRED' },
    });
    expect(tx.client.updateMany).toHaveBeenCalledWith({
      where: { id: 'client-1', tenantId: 'tenant-1', allowActive: true },
      data: { allowActive: false },
    });
    expect(result).toEqual({
      invalidatedChecks: 1,
      reviewCheckId: 'open-review',
      clientDeactivated: true,
    });
    expect(tx.gwgCheck.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgBeneficialOwner.deleteMany).not.toHaveBeenCalled();
    expect(tx.gwgIdDocument.deleteMany).not.toHaveBeenCalled();
  });

  it('öffentliches Onboarding legt immer einen frischen Review-Check an', async () => {
    const tx = {
      gwgCheck: {
        create: vi.fn().mockResolvedValue({ id: 'new-review' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      client: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as TxClient;

    const result = await startFreshGwgReviewTx(tx, {
      tenantId: 'tenant-1',
      clientId: 'client-1',
    });

    expect(tx.gwgCheck.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', clientId: 'client-1', status: 'IN_REVIEW' },
      select: { id: true },
    });
    expect(tx.gwgCheck.updateMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: 'VERIFIED', id: { not: 'new-review' } },
      data: { status: 'EXPIRED' },
    });
    expect(result).toEqual({
      invalidatedChecks: 1,
      reviewCheckId: 'new-review',
      clientDeactivated: true,
    });
  });
});
