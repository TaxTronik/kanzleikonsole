// =============================================================================
// RSS-Fetcher (Admin-Trigger) — zieht alle aktiven Feeds aus rss_feed,
// dedupliziert pro URL und persistiert neue Einträge in tax_news_item.
//
// Konsolidierung Round 12: Parser + Body-Cap leben in @taxtronik/rss.
// Diese Datei ist nur noch der DB-Orchestrator.
// =============================================================================

import { prismaOwner } from '@/server/db/prisma-owner';
import { fetchRssFeed, type FetchedRssItem } from '@taxtronik/rss';

export type FetchedItem = FetchedRssItem;

export async function fetchAndPersistTaxNews(): Promise<{
  feeds: number;
  fetched: number;
  inserted: number;
  newItems: Array<{
    id: string;
    source: string;
    title: string;
    link: string;
    publishedAt: Date | null;
  }>;
  errors: string[];
}> {
  const activeFeeds = await prismaOwner.rssFeed.findMany({
    where: { active: true },
    select: { url: true },
    distinct: ['url'],
  });

  const errors: string[] = [];
  const all: FetchedItem[] = [];
  for (const f of activeFeeds) {
    try {
      const items = await fetchRssFeed(f.url);
      all.push(...items);
    } catch (e) {
      errors.push(`${f.url}: ${(e as Error).message}`);
    }
  }

  const newItems: Array<{
    id: string;
    source: string;
    title: string;
    link: string;
    publishedAt: Date | null;
  }> = [];
  for (const item of all) {
    try {
      const created = await prismaOwner.taxNewsItem.create({
        data: {
          source: item.source,
          guid: item.guid,
          title: item.title,
          summary: item.summary,
          link: item.link,
          publishedAt: item.publishedAt,
        },
      });
      newItems.push({
        id: created.id,
        source: created.source,
        title: created.title,
        link: created.link,
        publishedAt: created.publishedAt,
      });
    } catch (e) {
      if (!(e as { code?: string }).code || (e as { code?: string }).code !== 'P2002') {
        errors.push(`Insert: ${(e as Error).message}`);
      }
    }
  }

  return {
    feeds: activeFeeds.length,
    fetched: all.length,
    inserted: newItems.length,
    newItems,
    errors,
  };
}
