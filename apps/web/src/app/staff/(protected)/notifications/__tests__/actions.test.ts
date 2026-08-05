import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  withStaff: vi.fn(),
  parseFormData: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', () => ({
  withStaff: m.withStaff,
  parseFormData: m.parseFormData,
}));

import { markNotificationReadByIdAction } from '../actions';

const ID = 'bc2cc432-b881-4c0e-80c3-35a86d08f76d';

describe('markNotificationReadByIdAction', () => {
  const tx = { notification: { updateMany: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    tx.notification.updateMany.mockResolvedValue({ count: 1 });
    m.withStaff.mockImplementation(
      async (
        fn: (client: typeof tx, context: { staffId: string }) => Promise<void>,
        _options: unknown,
      ) => {
        await fn(tx, { staffId: 'staff-1' });
        return { ok: true };
      },
    );
  });

  it('markiert nur eine sichtbare eigene oder kanzleiweite Notification', async () => {
    const result = await markNotificationReadByIdAction({ id: ID });

    expect(result).toEqual({ ok: true });
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        OR: [{ staffId: 'staff-1' }, { staffId: null }],
        readAt: null,
      },
      data: { readAt: expect.any(Date) },
    });
    expect(m.withStaff).toHaveBeenCalledWith(expect.any(Function), {
      revalidate: ['/staff/notifications', '/staff/dashboard'],
    });
  });

  it('weist ungültige IDs vor dem Datenbankzugriff ab', async () => {
    await expect(markNotificationReadByIdAction({ id: 'keine-uuid' })).resolves.toEqual({
      ok: false,
      error: 'Validierungsfehler.',
    });
    expect(m.withStaff).not.toHaveBeenCalled();
  });
});
