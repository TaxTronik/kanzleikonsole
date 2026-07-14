import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tx: {
    n8nConnection: { findUnique: vi.fn() },
    n8nDelivery: { count: vi.fn(), findMany: vi.fn() },
    n8nOutbox: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx, fn) => fn(h.tx)),
}));

import { readN8nSetupStatus } from '../status';

function delivery(id: number, status: 'DELIVERED' | 'FAILED') {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    endpointNameSnapshot: 'Workflow',
    targetUrl: 'https://n8n.example.test/webhook/workflow',
    status,
    attempts: 1,
    httpStatus: status === 'DELIVERED' ? 200 : 500,
    latencyMs: 25,
    lastError: status === 'FAILED' ? 'HTTP 500' : null,
    createdAt: new Date(`2026-07-14T10:${String(id % 60).padStart(2, '0')}:00Z`),
    deliveredAt: status === 'DELIVERED' ? new Date('2026-07-14T11:00:00Z') : null,
    outbox: {
      id: `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      event: 'request.opened',
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  h.tx.n8nConnection.findUnique.mockResolvedValue(null);
  h.tx.n8nDelivery.count
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(20)
    .mockResolvedValueOnce(51)
    .mockResolvedValueOnce(0);
  h.tx.n8nOutbox.count.mockResolvedValue(0);
  h.tx.n8nDelivery.findMany
    .mockResolvedValueOnce([delivery(999, 'DELIVERED')])
    .mockResolvedValueOnce(Array.from({ length: 51 }, (_, index) => delivery(index + 1, 'FAILED')));
  h.tx.n8nOutbox.findMany.mockResolvedValue([]);
});

describe('readN8nSetupStatus', () => {
  it('liefert offene Fehler unabhängig von den letzten erfolgreichen Zustellungen paginierbar', async () => {
    const result = await readN8nSetupStatus({
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorType: 'STAFF',
      actorId: '00000000-0000-4000-8000-000000000002',
    });

    expect(result.deliveryCounts.failed).toBe(51);
    expect(result.failedDeliveries).toHaveLength(50);
    expect(result.failedDeliveries.every((item) => item.status === 'FAILED')).toBe(true);
    expect(result.hasMoreFailedDeliveries).toBe(true);
    expect(result.recentDeliveries).toHaveLength(1);
    expect(result.recentDeliveries[0]?.status).toBe('DELIVERED');
    expect(h.tx.n8nDelivery.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: '00000000-0000-4000-8000-000000000001',
        status: 'FAILED',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      include: { outbox: { select: { id: true, event: true } } },
    });
  });
});
