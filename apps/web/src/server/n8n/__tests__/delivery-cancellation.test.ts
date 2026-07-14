import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeFailedN8nDelivery, cancelPendingN8nDeliveries } from '../deliveries';

const tx = {
  $queryRaw: vi.fn(),
  n8nDelivery: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  n8nOutbox: {
    update: vi.fn(),
  },
};

const transaction = tx as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.resetAllMocks();
  tx.n8nDelivery.updateMany.mockResolvedValue({ count: 1 });
  tx.n8nOutbox.update.mockResolvedValue({});
  tx.$queryRaw.mockResolvedValue([]);
});

describe('cancelPendingN8nDeliveries', () => {
  it('cancelt nur offene Deliveries eines Endpoints und aggregiert SKIPPED', async () => {
    tx.n8nDelivery.findMany
      .mockResolvedValueOnce([{ id: 'delivery-1', outboxId: 'outbox-1' }])
      .mockResolvedValueOnce([
        { status: 'SKIPPED', lastError: 'Route entfernt', deliveredAt: null },
      ]);

    const result = await cancelPendingN8nDeliveries(transaction, {
      tenantId: 'tenant-1',
      endpointId: 'endpoint-1',
      reason: 'Route entfernt',
    });

    expect(tx.n8nDelivery.findMany).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1', status: 'PENDING', endpointId: 'endpoint-1' },
      select: { id: true, outboxId: true },
    });
    expect(tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', status: 'PENDING', id: { in: ['delivery-1'] } },
      data: { status: 'SKIPPED', lastError: 'Route entfernt', deliveredAt: null },
    });
    expect(tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: { status: 'SKIPPED', deliveredAt: null, lastError: 'Route entfernt' },
    });
    expect(result).toEqual({ deliveryCount: 1, outboxIds: ['outbox-1'] });
  });

  it('cancelt beim Connection-Reset tenantweit und aggregiert gemischte Ziele PARTIAL', async () => {
    tx.n8nDelivery.updateMany.mockResolvedValue({ count: 2 });
    tx.n8nDelivery.findMany
      .mockResolvedValueOnce([
        { id: 'delivery-1', outboxId: 'outbox-1' },
        { id: 'delivery-2', outboxId: 'outbox-1' },
      ])
      .mockResolvedValueOnce([
        { status: 'DELIVERED', lastError: null, deliveredAt: new Date('2026-07-14T10:00:00Z') },
        { status: 'SKIPPED', lastError: 'Integration entfernt', deliveredAt: null },
      ]);

    const result = await cancelPendingN8nDeliveries(transaction, {
      tenantId: 'tenant-1',
      reason: 'Integration entfernt',
    });

    expect(tx.n8nDelivery.findMany).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1', status: 'PENDING' },
      select: { id: true, outboxId: true },
    });
    expect(tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: { status: 'PARTIAL', deliveredAt: null, lastError: 'Integration entfernt' },
    });
    expect(result).toEqual({ deliveryCount: 2, outboxIds: ['outbox-1'] });
  });
});

describe('acknowledgeFailedN8nDelivery', () => {
  it('quittiert FAILED atomar als SKIPPED und aggregiert das Parent-Event', async () => {
    tx.n8nDelivery.findFirst.mockResolvedValue({
      id: 'delivery-1',
      outboxId: 'outbox-1',
      targetUrl: 'https://n8n.example.test/webhook/old',
      lastError: 'HTTP 404',
    });
    tx.n8nDelivery.findMany.mockResolvedValue([
      {
        status: 'SKIPPED',
        lastError: 'Administrativ quittiert. Ursprünglicher Fehler: HTTP 404',
        deliveredAt: null,
      },
    ]);

    const result = await acknowledgeFailedN8nDelivery(transaction, {
      tenantId: 'tenant-1',
      deliveryId: 'delivery-1',
    });

    expect(tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', tenantId: 'tenant-1', status: 'FAILED' },
      data: expect.objectContaining({
        status: 'SKIPPED',
        deliveredAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
    expect(tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'SKIPPED', deliveredAt: null }),
    });
    expect(result).toEqual({
      id: 'delivery-1',
      outboxId: 'outbox-1',
      targetUrl: 'https://n8n.example.test/webhook/old',
    });
  });

  it('aggregiert nach verlorenem Status-Rennen nicht', async () => {
    tx.n8nDelivery.findFirst.mockResolvedValue({
      id: 'delivery-1',
      outboxId: 'outbox-1',
      targetUrl: null,
      lastError: null,
    });
    tx.n8nDelivery.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      acknowledgeFailedN8nDelivery(transaction, {
        tenantId: 'tenant-1',
        deliveryId: 'delivery-1',
      }),
    ).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.n8nOutbox.update).not.toHaveBeenCalled();
  });
});
