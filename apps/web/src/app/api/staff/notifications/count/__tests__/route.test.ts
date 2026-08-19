import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  withTenantContext: vi.fn(),
  aggregate: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));

import { GET } from '../route';

describe('GET /api/staff/notifications/count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.staffAuth.mockResolvedValue({
      user: { tenantId: '11111111-1111-1111-1111-111111111111', staffId: 'staff-1' },
    });
    m.withTenantContext.mockImplementation(async (_ctx, fn) =>
      fn({ notification: { aggregate: m.aggregate } }),
    );
  });

  it('liefert neben der Anzahl den Zeitstempel des jüngsten ungelesenen Eintrags', async () => {
    m.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { createdAt: new Date('2026-08-19T10:05:00.000Z') },
    });

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      unread: 1,
      latestUnreadAt: '2026-08-19T10:05:00.000Z',
    });
    expect(m.aggregate).toHaveBeenCalledWith({
      where: { OR: [{ staffId: 'staff-1' }, { staffId: null }], readAt: null },
      _count: { _all: true },
      _max: { createdAt: true },
    });
  });

  it('öffnet ohne Staff-Session keinen Tenant-Kontext', async () => {
    m.staffAuth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });
});
