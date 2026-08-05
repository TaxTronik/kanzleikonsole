import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withStaff: vi.fn(),
  fetchAndPersistTaxNews: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: m.staffActionGuard,
  withStaff: m.withStaff,
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: Error) => ({ ok: false, error: error.message }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/tax-news/fetcher', () => ({
  fetchAndPersistTaxNews: m.fetchAndPersistTaxNews,
}));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));

import { triggerTaxNewsFetchAction } from '../tax-news-actions';

describe('triggerTaxNewsFetchAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
    });
    m.fetchAndPersistTaxNews.mockResolvedValue({
      inserted: 2,
      fetched: 5,
      errors: [],
    });
  });

  it('erlaubt den Refresh ohne Admin-Gate und reicht den Mitarbeiter-Scope weiter', async () => {
    const result = await triggerTaxNewsFetchAction();

    expect(m.staffActionGuard).toHaveBeenCalledWith();
    expect(m.fetchAndPersistTaxNews).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      staffId: 'staff-1',
    });
    expect(result).toEqual({ ok: true, inserted: 2, fetched: 5, errors: [] });
    expect(m.revalidatePath).toHaveBeenCalledWith('/staff/dashboard');
  });
});
