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

// R-11: RSS-Titel aus externen Feeds laufen über notify() und damit durch den
// gemeinsamen Sanitizer (echter @taxtronik/db/notification-Pfad, Tx gemockt).
describe('tax-news-fetch Benachrichtigungen', () => {
  const FEED = 'https://feed.example.test/rss.xml';
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    notification: { findMany: vi.fn(), update: vi.fn(), createMany: vi.fn() },
  };

  beforeEach(() => {
    h.moduleEnabled.mockResolvedValue(true);
    h.rssFeedFindMany
      .mockResolvedValueOnce([{ tenantId: 'tenant-1', url: FEED }])
      .mockResolvedValueOnce([
        { tenantId: 'tenant-1', staffId: 'staff-1', name: 'BMF', url: FEED },
      ]);
    h.fetchRssFeed.mockResolvedValue([
      {
        source: FEED,
        guid: 'guid-1',
        title: 'Neu <img src=x>\u202e',
        summary: '',
        link: 'https://example.test/1',
        publishedAt: new Date(),
      },
    ]);
    h.taxNewsFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'item-1', source: FEED, title: 'Neu <img src=x>\u202e', link: 'https://x' },
      ]);
    h.taxNewsCreateMany.mockResolvedValue({ count: 1 });
    h.notificationFindMany.mockResolvedValue([]);
    h.tenantSettingUpsert.mockResolvedValue({});
    h.withWorkerTenantContext.mockImplementation(
      async (_tenantId: string, fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    );
    tx.$queryRaw.mockResolvedValue([{ actorType: 'SYSTEM' }]);
    tx.$executeRaw.mockResolvedValue(1);
    tx.notification.findMany.mockResolvedValue([]);
    tx.notification.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({
      count: data.length,
    }));
  });

  it('schreibt den Feed-Titel nur sanitisiert', async () => {
    await expect(processors.get('tax-news-fetch')!({ data: {} })).resolves.toMatchObject({
      inserted: 1,
      notifications: 1,
    });

    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tenantId: 'tenant-1',
          staffId: 'staff-1',
          kind: 'TAX_NEWS_NEW',
          title: 'BMF: Neu ‹img src=x>',
          resourceType: 'tax_news_item',
          resourceId: 'item-1',
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('benachrichtigt nicht erneut, wenn es (auch gelesen) schon eine Notification gibt', async () => {
    h.notificationFindMany.mockResolvedValue([{ staffId: 'staff-1', resourceId: 'item-1' }]);

    await expect(processors.get('tax-news-fetch')!({ data: {} })).resolves.toMatchObject({
      notifications: 0,
    });

    expect(tx.notification.createMany).not.toHaveBeenCalled();
  });
});
