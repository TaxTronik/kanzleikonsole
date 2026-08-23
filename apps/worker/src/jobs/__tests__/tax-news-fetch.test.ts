import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  moduleEnabled: vi.fn(),
  fetchRssFeed: vi.fn(),
  rssFeedFindMany: vi.fn(),
  taxNewsFindMany: vi.fn(),
  taxNewsCreateMany: vi.fn(),
  notificationFindMany: vi.fn(),
  tenantSettingUpsert: vi.fn(),
  withWorkerTenantContext: vi.fn(),
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/rss', () => ({ fetchRssFeed: h.fetchRssFeed }));
vi.mock('../../module-gate', () => ({
  isWorkerTenantModuleEnabled: h.moduleEnabled,
}));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: h.withWorkerTenantContext,
}));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    rssFeed: { findMany: h.rssFeedFindMany },
    taxNewsItem: {
      findMany: h.taxNewsFindMany,
      createMany: h.taxNewsCreateMany,
    },
    notification: { findMany: h.notificationFindMany },
    tenantSetting: { upsert: h.tenantSettingUpsert },
  },
}));

import { processors } from './mocks/bullmq';
import '../tax-news-fetch';

beforeEach(() => {
  vi.resetAllMocks();
  h.rssFeedFindMany.mockResolvedValue([
    { tenantId: 'tenant-disabled', url: 'https://example.test/feed.xml' },
  ]);
  h.moduleEnabled.mockResolvedValue(false);
});

describe('tax-news-fetch tenant module gate', () => {
  it('holt und persistiert nichts, wenn alle RSS-Tenants deaktiviert sind', async () => {
    await expect(processors.get('tax-news-fetch')!({ data: {} })).resolves.toEqual({
      feeds: 0,
      fetched: 0,
      inserted: 0,
      notifications: 0,
    });

    expect(h.moduleEnabled).toHaveBeenCalledWith('tenant-disabled', 'rssReader');
    expect(h.fetchRssFeed).not.toHaveBeenCalled();
    expect(h.taxNewsFindMany).not.toHaveBeenCalled();
    expect(h.taxNewsCreateMany).not.toHaveBeenCalled();
    expect(h.notificationFindMany).not.toHaveBeenCalled();
    expect(h.tenantSettingUpsert).not.toHaveBeenCalled();
    expect(h.withWorkerTenantContext).not.toHaveBeenCalled();
  });
});
