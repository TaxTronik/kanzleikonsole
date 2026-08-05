// =============================================================================
// RSS-Fetcher (manueller Dashboard-Trigger) — zieht die aktiven Feeds im
// angeforderten Scope, dedupliziert pro URL und persistiert neue Einträge in
// tax_news_item. Der globale automatische Lauf lebt separat im Worker.
//
// Konsolidierung Round 12: Parser + Body-Cap leben in @taxtronik/rss.
// Diese Datei ist nur noch der DB-Orchestrator.
// =============================================================================

import { prismaOwner } from '@/server/db/prisma-owner';
import { fetchRssFeed, type FetchedRssItem } from '@taxtronik/rss';

export type FetchedItem = FetchedRssItem;

export interface TaxNewsFetchScope {
  tenantId: string;
  staffId: string;
}

export async function fetchAndPersistTaxNews(scope: TaxNewsFetchScope): Promise<{
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
    where: {
      active: true,
      tenantId: scope.tenantId,
      staffId: scope.staffId,
    },
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

  // Der Worker schreibt den globalen Tenant-Marker. Ein manueller Abruf lädt
  // dagegen nur die Feeds EINER Person und bekommt deshalb einen eigenen
  // Marker — sonst sähen Kollegen ihre abweichenden Feeds fälschlich als
  // frisch aktualisiert.
  const markerTargets = [
    { tenantId: scope.tenantId, key: `tax-news.last-fetch-at.${scope.staffId}` },
  ];
  const lastFetchAt = new Date().toISOString();
  for (const { tenantId, key } of markerTargets) {
    await prismaOwner.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: { value: lastFetchAt },
      create: { tenantId, key, value: lastFetchAt },
    });
  }

  return {
    feeds: activeFeeds.length,
    fetched: all.length,
    inserted: newItems.length,
    newItems,
    errors,
  };
}
