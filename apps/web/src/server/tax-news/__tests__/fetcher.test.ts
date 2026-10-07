// Fachkatalog: ACCESS-TENANT-RLS-001
// S-01: Der manuelle Abruf läuft vollständig im Kontext des Mitarbeiters
// (App-Rolle, fetcher-db.test.ts), auch der globale Nachrichten-Cache.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rssFeedFindMany: vi.fn(),
  taxNewsCreate: vi.fn(),
  tenantSettingUpsert: vi.fn(),
  fetchRssFeed: vi.fn(),
  readBooleanTenantModules: vi.fn(),
  contexts: [] as unknown[],
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    m.contexts.push(ctx);
    return fn({
      rssFeed: { findMany: m.rssFeedFindMany },
      taxNewsItem: { create: m.taxNewsCreate },
      tenantSetting: { upsert: m.tenantSettingUpsert },
    });
  },
}));
vi.mock('@taxtronik/rss', () => ({ fetchRssFeed: m.fetchRssFeed }));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: m.readBooleanTenantModules,
}));

import { fetchAndPersistTaxNews } from '../fetcher';

const staff = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' };

describe('fetchAndPersistTaxNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.contexts.length = 0;
    m.rssFeedFindMany.mockResolvedValue([{ url: 'https://example.com/feed.xml' }]);
    m.fetchRssFeed.mockResolvedValue([]);
    m.tenantSettingUpsert.mockResolvedValue({});
    m.readBooleanTenantModules.mockResolvedValue({ rssReader: true });
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
    expect(m.contexts).toEqual([staff, staff]);
  });

  it('legt jeden Cache-Eintrag in eigener Transaktion an und überspringt Duplikate', async () => {
    const item = (guid: string) => ({
      source: 'https://example.com/feed.xml',
      guid,
      title: `Titel ${guid}`,
      summary: null,
      link: `https://example.com/${guid}`,
      publishedAt: null,
    });
    m.fetchRssFeed.mockResolvedValue([item('a'), item('b')]);
    m.taxNewsCreate
      .mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }))
      .mockImplementationOnce(async ({ data }: { data: ReturnType<typeof item> }) => ({
        id: 'news-b',
        ...data,
      }));

    await expect(
      fetchAndPersistTaxNews({ tenantId: 'tenant-1', staffId: 'staff-1' }),
    ).resolves.toMatchObject({
      feeds: 1,
      fetched: 2,
      inserted: 1,
      newItems: [{ id: 'news-b', source: 'https://example.com/feed.xml' }],
      errors: [],
    });
    expect(m.taxNewsCreate).toHaveBeenCalledTimes(2);
    // Feeds, je Eintrag eine Transaktion, Marker.
    expect(m.contexts).toEqual([staff, staff, staff, staff]);
  });

  it('bricht bei deaktiviertem Modul vor jedem Abruf ab', async () => {
    m.readBooleanTenantModules.mockResolvedValue({ rssReader: false });

    await expect(
      fetchAndPersistTaxNews({ tenantId: 'tenant-1', staffId: 'staff-1' }),
    ).rejects.toThrow('Modul rssReader ist deaktiviert.');
    expect(m.rssFeedFindMany).not.toHaveBeenCalled();
    expect(m.fetchRssFeed).not.toHaveBeenCalled();
  });
});
