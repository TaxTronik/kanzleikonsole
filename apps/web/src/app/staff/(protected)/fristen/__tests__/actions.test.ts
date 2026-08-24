import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fachkatalog: TAX-CONTROL-STATUS-001

const mocks = vi.hoisted(() => ({
  withStaff: vi.fn(),
  createDailyReviewTx: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', () => ({
  withStaff: mocks.withStaff,
}));

vi.mock('@/server/fristen/tagesabschluss', () => ({
  createDailyReviewTx: mocks.createDailyReviewTx,
}));

import { completeDailyReviewAction } from '../actions';

describe('completeDailyReviewAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withStaff.mockImplementation(async (fn, options) => {
      const payload = await fn(
        { tx: true },
        {
          tenantId: 'tenant-1',
          staffId: 'staff-1',
          session: { user: { roles: ['ADMIN'] } },
        },
      );
      return { ok: true, ...payload, options };
    });
    mocks.createDailyReviewTx.mockResolvedValue({
      id: 'review-1',
      openCount: 2,
      overdueCount: 1,
      dueTodayCount: 1,
    });
  });

  it('erzwingt ADMIN/PARTNER und reicht die Notiz an den tenantgebundenen Service', async () => {
    const form = new FormData();
    form.set('escalationNote', 'Heute durch Partnerin nachzuverfolgen.');

    const result = await completeDailyReviewAction(null, form);

    expect(mocks.withStaff).toHaveBeenCalledWith(expect.any(Function), {
      requireAdmin: true,
      transactionIsolationLevel: 'RepeatableRead',
      uniqueError: 'Die Abschlusskontrolle für heute wurde bereits dokumentiert.',
      revalidate: '/staff/fristen',
    });
    expect(mocks.createDailyReviewTx).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        tenantId: 'tenant-1',
        staffId: 'staff-1',
        escalationNote: 'Heute durch Partnerin nachzuverfolgen.',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      reviewId: 'review-1',
      openCount: 2,
    });
  });

  it('weist überlange Notizen vor Auth/DB zurück', async () => {
    const form = new FormData();
    form.set('escalationNote', 'x'.repeat(4001));

    await expect(completeDailyReviewAction(null, form)).resolves.toMatchObject({ ok: false });
    expect(mocks.withStaff).not.toHaveBeenCalled();
  });
});
