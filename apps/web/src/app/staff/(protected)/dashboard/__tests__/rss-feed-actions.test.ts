// Fachkatalog: ACCESS-TENANT-RLS-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  tenantContext: vi.fn(),
  moduleEnabled: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  evidence: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: h.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: () => false,
  hasStaffPermission: () => false,
  toActionError: () => ({ ok: false, error: 'Nicht verfügbar.' }),
  ActionError: class ActionError extends Error {},
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.tenantContext }));
vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: h.tenantContext }));
vi.mock('@/server/settings/modules', () => ({
  assertModuleEnabled: h.moduleEnabled,
  ModuleDisabledError: class ModuleDisabledError extends Error {},
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidence } }));
vi.mock('@/server/rss/defaults', () => ({ seedDefaultRssFeeds: vi.fn() }));
vi.mock('@/server/http/ssrf-guard', () => ({ assertPublicUrl: vi.fn() }));

import { deleteRssFeedAction, toggleRssFeedAction } from '../rss-feed-actions';

const OWN_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
type Feed = {
  id: string;
  tenantId: string;
  staffId: string;
  name: string;
  url: string;
  active: boolean;
};
const feeds = new Map<string, Feed>();

function matching(where: Record<string, unknown>) {
  const feed = feeds.get(String(where.id));
  return feed && Object.entries(where).every(([key, value]) => feed[key as keyof Feed] === value)
    ? feed
    : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  feeds.clear();
  for (const [id, tenantId, staffId] of [
    [OWN_ID, 'tenant-a', 'staff-a'],
    [FOREIGN_ID, 'tenant-a', 'staff-b'],
    [OTHER_TENANT_ID, 'tenant-b', 'staff-a'],
  ]) {
    feeds.set(id!, {
      id: id!,
      tenantId: tenantId!,
      staffId: staffId!,
      name: 'Feed',
      url: 'https://example.test/rss',
      active: true,
    });
  }
  h.staffAuth.mockResolvedValue({
    user: { tenantId: 'tenant-a', staffId: 'staff-a', roles: ['EMPLOYEE'] },
  });
  h.moduleEnabled.mockResolvedValue(undefined);
  h.tenantContext.mockImplementation(async (_ctx, fn) =>
    fn({ rssFeed: { findFirst: h.findFirst, update: h.update, delete: h.delete } }),
  );
  h.findFirst.mockImplementation(async ({ where }) => matching(where));
  h.update.mockImplementation(async ({ where, data }) => {
    const feed = matching(where);
    if (!feed) throw new Error('Record not found');
    Object.assign(feed, data);
    return feed;
  });
  h.delete.mockImplementation(async ({ where }) => {
    const feed = matching(where);
    if (!feed) throw new Error('Record not found');
    feeds.delete(feed.id);
    return feed;
  });
  h.evidence.mockResolvedValue(undefined);
});

describe('ACCESS-TENANT-RLS-001: personal RSS mutations', () => {
  it.each([FOREIGN_ID, OTHER_TENANT_ID])(
    'rejects toggling or deleting a foreign feed %s',
    async (id) => {
      await expect(toggleRssFeedAction({ id, active: false })).resolves.toMatchObject({
        ok: false,
      });
      await expect(deleteRssFeedAction({ id })).resolves.toMatchObject({ ok: false });
      expect(feeds.get(id)?.active).toBe(true);
      expect(h.delete).not.toHaveBeenCalled();
      expect(h.evidence).not.toHaveBeenCalled();
    },
  );

  it('continues to toggle/delete own feeds and audits successful changes', async () => {
    await expect(toggleRssFeedAction({ id: OWN_ID, active: false })).resolves.toMatchObject({
      ok: true,
    });
    expect(feeds.get(OWN_ID)?.active).toBe(false);
    await expect(deleteRssFeedAction({ id: OWN_ID })).resolves.toMatchObject({ ok: true });
    expect(feeds.has(OWN_ID)).toBe(false);
    expect(h.evidence).toHaveBeenCalledTimes(2);
    expect(h.evidence.mock.calls.map(([, event]) => event.action)).toEqual([
      'rss_feed.disable',
      'rss_feed.delete',
    ]);
  });

  it('does not reach personal feeds without a staff session', async () => {
    h.staffAuth.mockResolvedValue(null);
    await expect(toggleRssFeedAction({ id: OWN_ID, active: false })).resolves.toMatchObject({
      ok: false,
    });
    await expect(deleteRssFeedAction({ id: OWN_ID })).resolves.toMatchObject({ ok: false });
    expect(h.tenantContext).not.toHaveBeenCalled();
  });
});
