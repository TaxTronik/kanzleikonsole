// =============================================================================
// tax-news-fetch-Worker (RSS-Reader)
//
// Täglich um 05:30 UTC: alle aktiven RSS-Feeds (rss_feed.active=true) holen,
// neue Einträge in tax_news_item ablegen, pro neuem Item den abonnierten
// Staff-Members (mit taxNewsNotify=true) eine Notification anlegen.
//
// Konsolidierung Round 12: Parser + Body-Cap aus @taxtronik/rss.
// =============================================================================

import { Worker } from 'bullmq';
import { fetchRssFeed, type FetchedRssItem } from '@taxtronik/rss';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

export const taxNewsFetchWorker = new Worker<ChecksJob>(
  'tax-news-fetch',
  async () => {
    // Distinct URLs aus aktiven Feeds — pro URL nur ein Fetch.
    const activeFeeds = await prismaOwner.rssFeed.findMany({
      where: { active: true },
      select: { url: true },
      distinct: ['url'],
    });

    const errors: string[] = [];
    const all: FetchedRssItem[] = [];
    for (const f of activeFeeds) {
      try {
        const items = await fetchRssFeed(f.url);
        all.push(...items);
      } catch (e) {
        errors.push(`${f.url}: ${(e as Error).message}`);
      }
    }

    const newItems: Array<{ id: string; source: string; title: string; link: string }> = [];
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
        newItems.push({ id: created.id, source: created.source, title: created.title, link: created.link });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') {
          errors.push(`Insert: ${(e as Error).message}`);
        }
      }
    }

    if (errors.length > 0) log.warn({ errors }, 'tax-news-fetch: partial errors');

    if (newItems.length === 0) {
      log.info({ feeds: activeFeeds.length, fetched: all.length }, 'tax-news-fetch: no new items');
      return { feeds: activeFeeds.length, fetched: all.length, inserted: 0 };
    }

    // Pro neuem Item: jeder Staff, der diese URL aktiv abonniert hat UND
    // taxNewsNotify=true gesetzt hat, bekommt eine Notification.
    let notifications = 0;
    for (const item of newItems) {
      const subscribers = await prismaOwner.rssFeed.findMany({
        where: {
          url: item.source,
          active: true,
          staff: { active: true, taxNewsNotify: true },
        },
        select: { tenantId: true, staffId: true, name: true },
      });
      for (const sub of subscribers) {
        const exists = await prismaOwner.notification.findFirst({
          where: {
            tenantId: sub.tenantId,
            staffId: sub.staffId,
            kind: 'TAX_NEWS_NEW',
            resourceType: 'tax_news_item',
            resourceId: item.id,
          },
        });
        if (exists) continue;
        await prismaOwner.notification.create({
          data: {
            tenantId: sub.tenantId,
            staffId: sub.staffId,
            kind: 'TAX_NEWS_NEW',
            title: `${sub.name}: ${item.title}`,
            body: null,
            href: '/staff/dashboard',
            resourceType: 'tax_news_item',
            resourceId: item.id,
          },
        });
        notifications++;
      }
    }

    log.info(
      { feeds: activeFeeds.length, fetched: all.length, inserted: newItems.length, notifications },
      'tax-news-fetch: done',
    );
    return { feeds: activeFeeds.length, fetched: all.length, inserted: newItems.length, notifications };
  },
  { connection, concurrency: 1 },
);

taxNewsFetchWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'tax-news-fetch failed');
});
