// S-01: Abonnenten, vorhandene und neue Hinweise sowie der Lauf-Marker laufen
// je Tenant im SYSTEM-Kontext (tax-news-fetch-db.test.ts: App-Rolle).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  moduleEnabled: vi.fn(),
  fetchRssFeed: vi.fn(),
  rssFeedFindMany: vi.fn(),
  subscriberFindMany: vi.fn(),
  taxNewsFindMany: vi.fn(),
  taxNewsCreateMany: vi.fn(),
  existingNotifications: [] as Array<{ staffId: string; resourceId: string }>,
  tenantSettingUpsert: vi.fn(),
  withSystemContext: vi.fn(),
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
vi.mock('@taxtronik/db', () => ({ withSystemContext: h.withSystemContext }));
vi.mock('../../prisma-owner', () => ({
  prismaOwner: {
    rssFeed: { findMany: h.rssFeedFindMany },
    taxNewsItem: {
      findMany: h.taxNewsFindMany,
      createMany: h.taxNewsCreateMany,
    },
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
    expect(h.tenantSettingUpsert).not.toHaveBeenCalled();
    expect(h.withSystemContext).not.toHaveBeenCalled();
  });
});

// R-11: RSS-Titel aus externen Feeds laufen über notify() und damit durch den
// gemeinsamen Sanitizer (echter @taxtronik/db/notification-Pfad, Tx gemockt).
describe('tax-news-fetch Benachrichtigungen', () => {
  const FEED = 'https://feed.example.test/rss.xml';
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    rssFeed: { findMany: h.subscriberFindMany },
    notification: { findMany: vi.fn(), update: vi.fn(), createMany: vi.fn() },
    tenantSetting: { upsert: h.tenantSettingUpsert },
  };

  beforeEach(() => {
    h.moduleEnabled.mockResolvedValue(true);
    h.rssFeedFindMany.mockResolvedValue([{ tenantId: 'tenant-1', url: FEED }]);
    h.subscriberFindMany.mockResolvedValue([{ staffId: 'staff-1', name: 'BMF', url: FEED }]);
    h.existingNotifications = [];
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
    h.tenantSettingUpsert.mockResolvedValue({});
    h.withSystemContext.mockImplementation(
      async (_tenantId: string, fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
    );
    tx.$queryRaw.mockResolvedValue([{ actorType: 'SYSTEM' }]);
    tx.$executeRaw.mockResolvedValue(1);
    // Die Dedupe-Abfrage des Jobs wählt nur staffId/resourceId, notify() auch die id.
    tx.notification.findMany.mockImplementation(async (args: { select: { id?: boolean } }) =>
      args.select.id ? [] : h.existingNotifications,
    );
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
    // Abonnenten, Hinweise und Lauf-Marker im SYSTEM-Kontext genau dieses Tenants.
    expect(h.subscriberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-1' }) }),
    );
    expect(h.withSystemContext.mock.calls.map(([tenantId]) => tenantId)).toEqual([
      'tenant-1',
      'tenant-1',
      'tenant-1',
    ]);
    expect(h.tenantSettingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_key: { tenantId: 'tenant-1', key: 'tax-news.last-fetch-at' } },
      }),
    );
  });

  it('benachrichtigt nicht erneut, wenn es (auch gelesen) schon eine Notification gibt', async () => {
    h.existingNotifications = [{ staffId: 'staff-1', resourceId: 'item-1' }];

    await expect(processors.get('tax-news-fetch')!({ data: {} })).resolves.toMatchObject({
      notifications: 0,
    });

    expect(tx.notification.createMany).not.toHaveBeenCalled();
  });
});
