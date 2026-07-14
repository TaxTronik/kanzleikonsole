import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prismaOwner: {
    n8nOutbox: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    n8nCallbackReceipt: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({ log: h.log }));

import {
  N8N_CALLBACK_RECEIPT_RETENTION_DAYS,
  N8N_EXCEPTION_RETENTION_DAYS,
  N8N_ROUTINE_RETENTION_DAYS,
  runN8nRetention,
} from '../n8n-retention';

const NOW = new Date('2026-07-14T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

beforeEach(() => {
  vi.resetAllMocks();
  h.prismaOwner.n8nOutbox.deleteMany.mockResolvedValue({ count: 1 });
  h.prismaOwner.n8nCallbackReceipt.deleteMany.mockResolvedValue({ count: 1 });
});

describe('n8n retention', () => {
  it('löscht normale und fehlerhafte Terminal-Historie mit getrennten Fristen', async () => {
    h.prismaOwner.n8nOutbox.findMany
      .mockResolvedValueOnce([{ id: 'routine-1' }])
      .mockResolvedValueOnce([{ id: 'exception-1' }]);
    h.prismaOwner.n8nCallbackReceipt.findMany.mockResolvedValueOnce([{ id: 'receipt-1' }]);

    const result = await runN8nRetention(NOW);

    const routineCutoff = new Date(NOW.getTime() - N8N_ROUTINE_RETENTION_DAYS * DAY_MS);
    const exceptionCutoff = new Date(NOW.getTime() - N8N_EXCEPTION_RETENTION_DAYS * DAY_MS);
    const callbackReceiptCutoff = new Date(
      NOW.getTime() - N8N_CALLBACK_RECEIPT_RETENTION_DAYS * DAY_MS,
    );
    expect(h.prismaOwner.n8nOutbox.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: { in: ['DELIVERED', 'SKIPPED', 'UNROUTED'] },
        updatedAt: { lt: routineCutoff },
        deliveries: { none: { status: { in: ['PENDING', 'PROCESSING'] } } },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    });
    expect(h.prismaOwner.n8nOutbox.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: { in: ['FAILED', 'PARTIAL'] },
        updatedAt: { lt: exceptionCutoff },
        deliveries: { none: { status: { in: ['PENDING', 'PROCESSING'] } } },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    });
    expect(h.prismaOwner.n8nOutbox.deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: ['routine-1'] },
        status: { in: ['DELIVERED', 'SKIPPED', 'UNROUTED'] },
        updatedAt: { lt: routineCutoff },
        deliveries: { none: { status: { in: ['PENDING', 'PROCESSING'] } } },
      },
    });
    expect(h.prismaOwner.n8nCallbackReceipt.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: callbackReceiptCutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    expect(h.prismaOwner.n8nCallbackReceipt.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['receipt-1'] },
        createdAt: { lt: callbackReceiptCutoff },
      },
    });
    expect(result).toEqual({
      routineDeleted: 1,
      exceptionDeleted: 1,
      callbackReceiptsDeleted: 1,
    });
  });

  it('ist ohne alte Terminal-Kandidaten ein No-op', async () => {
    h.prismaOwner.n8nOutbox.findMany.mockResolvedValue([]);
    h.prismaOwner.n8nCallbackReceipt.findMany.mockResolvedValue([]);

    await expect(runN8nRetention(NOW)).resolves.toEqual({
      routineDeleted: 0,
      exceptionDeleted: 0,
      callbackReceiptsDeleted: 0,
    });
    expect(h.prismaOwner.n8nOutbox.deleteMany).not.toHaveBeenCalled();
    expect(h.prismaOwner.n8nCallbackReceipt.deleteMany).not.toHaveBeenCalled();
  });
});
