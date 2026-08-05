import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rssFeedFindMany: vi.fn(),
  taxNewsCreate: vi.fn(),
  tenantSettingUpsert: vi.fn(),
  fetchRssFeed: vi.fn(),
}));

vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: {
    rssFeed: { findMany: m.rssFeedFindMany },
    taxNewsItem: { create: m.taxNewsCreate },
    tenantSetting: { upsert: m.tenantSettingUpsert },
  },
}));
vi.mock('@taxtronik/rss', () => ({ fetchRssFeed: m.fetchRssFeed }));

import { fetchAndPersistTaxNews } from '../fetcher';

describe('fetchAndPersistTaxNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.rssFeedFindMany.mockResolvedValue([{ url: 'https://example.com/feed.xml' }]);
    m.fetchRssFeed.mockResolvedValue([]);
    m.tenantSettingUpsert.mockResolvedValue({});
  });

  it('beschränkt einen Mitarbeiter-Refresh auf dessen eigene Feeds und Tenant-Marker', async () => {
    await fetchAndPersistTaxNews({ tenantId: 'tenant-1', staffId: 'staff-1' });

    expect(m.rssFeedFindMany).toHaveBeenCalledTimes(1);
    expect(m.rssFeedFindMany).toHaveBeenCalledWith({
      where: { active: true, tenantId: 'tenant-1', staffId: 'staff-1' },
      select: { url: true },
      distinct: ['url'],
    });
    expect(m.fetchRssFeed).toHaveBeenCalledWith('https://example.com/feed.xml');
    expect(m.tenantSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_key: {
            tenantId: 'tenant-1',
            key: 'tax-news.last-fetch-at.staff-1',
          },
        },
      }),
    );
  });
});
