import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  withTenantContext: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));

import { GET } from '../route';

describe('GET /api/staff/notifications/recent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.staffAuth.mockResolvedValue({
      user: { tenantId: '11111111-1111-1111-1111-111111111111', staffId: 'staff-1' },
    });
    m.withTenantContext.mockImplementation(async (_ctx, fn) =>
      fn({ notification: { findMany: m.findMany, count: m.count } }),
    );
  });

  it('lädt Liste und Zähler in genau einem Tenant-Kontext', async () => {
    m.findMany.mockResolvedValue([
      {
        id: 'notification-1',
        kind: 'INFO',
        title: 'Titel',
        body: 'Text',
        href: null,
        createdAt: new Date('2026-07-16T08:00:00.000Z'),
        readAt: null,
      },
    ]);
    m.count.mockResolvedValue(3);

    const response = await GET();

    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(m.withTenantContext).toHaveBeenCalledWith(
      {
        tenantId: '11111111-1111-1111-1111-111111111111',
        actorId: 'staff-1',
        actorType: 'STAFF',
      },
      expect.any(Function),
    );
    expect(m.findMany).toHaveBeenCalledTimes(1);
    expect(m.count).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: 'notification-1',
          kind: 'INFO',
          title: 'Titel',
          body: 'Text',
          href: null,
          createdAt: '2026-07-16T08:00:00.000Z',
          readAt: null,
        },
      ],
      unread: 3,
      latestUnreadAt: '2026-07-16T08:00:00.000Z',
    });
  });

  it('öffnet ohne Staff-Session keinen Tenant-Kontext', async () => {
    m.staffAuth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });
});
