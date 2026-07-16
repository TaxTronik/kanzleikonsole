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
import { withWorkerTenantContext } from '../tenant-context';

const RSS_FETCH_CONCURRENCY = 5;
const DB_BATCH_SIZE = 250;
// Nur für „frische" Items benachrichtigen. Bindet den Kandidatensatz an die
// jüngere Vergangenheit, damit ein Feed, der ältere Einträge weiter listet,
// keine Backfill-Flut auslöst — deckt aber das Retry-Fenster ab (Item wurde in
// einem vorherigen, abgebrochenen Lauf schon eingefügt).
const NOTIFY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function itemKey(source: string, guid: string): string {
  return `${source}\u0000${guid}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
    for (const batch of chunks(activeFeeds, RSS_FETCH_CONCURRENCY)) {
      const results = await Promise.allSettled(batch.map((f) => fetchRssFeed(f.url)));
      results.forEach((result, index) => {
        const feed = batch[index]!;
        if (result.status === 'fulfilled') {
          all.push(...result.value);
        } else {
          errors.push(`${feed.url}: ${(result.reason as Error).message}`);
        }
      });
    }

    const uniqueFetched = Array.from(
      new Map(all.map((item) => [itemKey(item.source, item.guid), item])).values(),
    );

    const existingKeys = new Set<string>();
    for (const batch of chunks(uniqueFetched, DB_BATCH_SIZE)) {
      const existing = await prismaOwner.taxNewsItem.findMany({
        where: {
          OR: batch.map((item) => ({ source: item.source, guid: item.guid })),
        },
        select: { source: true, guid: true },
      });
      for (const item of existing) existingKeys.add(itemKey(item.source, item.guid));
    }

    const toInsert = uniqueFetched.filter(
      (item) => !existingKeys.has(itemKey(item.source, item.guid)),
    );
    let inserted = 0;
    for (const batch of chunks(toInsert, DB_BATCH_SIZE)) {
      try {
        const result = await prismaOwner.taxNewsItem.createMany({
          data: batch.map((item) => ({
            source: item.source,
            guid: item.guid,
            title: item.title,
            summary: item.summary,
            link: item.link,
            publishedAt: item.publishedAt,
          })),
          skipDuplicates: true,
        });
        inserted += result.count;
      } catch (e) {
        errors.push(`Insert: ${(e as Error).message}`);
      }
    }

    if (errors.length > 0) log.warn({ errors }, 'tax-news-fetch: partial errors');

    // Benachrichtigungs-Kandidaten sind ALLE frisch geholten Items (nicht nur
    // die in DIESEM Lauf eingefügten): Bricht ein Lauf zwischen Insert und
    // Notification-Phase ab, wären die Items beim Retry bereits vorhanden und
    // toInsert leer — die Abonnenten bekämen dann NIE eine Notification. Die
    // Idempotenz sichert weiter unten `existingNotificationKeys`.
    const notifyCutoff = Date.now() - NOTIFY_MAX_AGE_MS;
    const notifyCandidates = uniqueFetched.filter(
      // Ohne publishedAt lässt sich das Alter nicht bestimmen → einschließen
      // (lieber eine Notification zu viel als eine verpasste).
      (item) => item.publishedAt === null || item.publishedAt.getTime() >= notifyCutoff,
    );
    if (notifyCandidates.length === 0) {
      log.info(
        { feeds: activeFeeds.length, fetched: all.length, inserted },
        'tax-news-fetch: no items to notify',
      );
      return { feeds: activeFeeds.length, fetched: all.length, inserted, notifications: 0 };
    }

    const newItems: Array<{ id: string; source: string; title: string; link: string }> = [];
    for (const batch of chunks(notifyCandidates, DB_BATCH_SIZE)) {
      const rows = await prismaOwner.taxNewsItem.findMany({
        where: {
          OR: batch.map((item) => ({ source: item.source, guid: item.guid })),
        },
        select: { id: true, source: true, title: true, link: true },
      });
      newItems.push(...rows);
    }

    // Pro neuem Item: jeder Staff, der diese URL aktiv abonniert hat UND
    // taxNewsNotify=true gesetzt hat, bekommt eine Notification.
    const sources = Array.from(new Set(newItems.map((item) => item.source)));
    const subscribers = await prismaOwner.rssFeed.findMany({
      where: {
        url: { in: sources },
        active: true,
        staff: { active: true, taxNewsNotify: true },
      },
      select: { tenantId: true, staffId: true, name: true, url: true },
    });

    const subscribersBySource = new Map<string, typeof subscribers>();
    for (const sub of subscribers) {
      subscribersBySource.set(sub.url, [...(subscribersBySource.get(sub.url) ?? []), sub]);
    }

    const existingNotifications = await prismaOwner.notification.findMany({
      where: {
        kind: 'TAX_NEWS_NEW',
        resourceType: 'tax_news_item',
        resourceId: { in: newItems.map((item) => item.id) },
      },
      select: { staffId: true, resourceId: true },
    });
    const existingNotificationKeys = new Set(
      existingNotifications.map((n) => `${n.staffId ?? ''}\u0000${n.resourceId ?? ''}`),
    );

    const notificationRows = newItems.flatMap((item) =>
      (subscribersBySource.get(item.source) ?? [])
        .filter((sub) => !existingNotificationKeys.has(`${sub.staffId}\u0000${item.id}`))
        .map((sub) => ({
          tenantId: sub.tenantId,
          staffId: sub.staffId,
          kind: 'TAX_NEWS_NEW' as const,
          title: `${sub.name}: ${item.title}`,
          body: null,
          href: '/staff/dashboard',
          resourceType: 'tax_news_item',
          resourceId: item.id,
        })),
    );

    let notifications = 0;
    const notificationsByTenant = new Map<string, typeof notificationRows>();
    for (const row of notificationRows) {
      notificationsByTenant.set(row.tenantId, [
        ...(notificationsByTenant.get(row.tenantId) ?? []),
        row,
      ]);
    }
    for (const [tenantId, rows] of notificationsByTenant) {
      await withWorkerTenantContext(tenantId, async (tx) => {
        for (const batch of chunks(rows, DB_BATCH_SIZE)) {
          const result = await tx.notification.createMany({ data: batch });
          notifications += result.count;
        }
      });
    }

    // Lauf-Marker pro Tenant mit aktiven Feeds — das RSS-Widget zeigt daraus
    // "aktualisiert am". Bewusst auch bei 0 neuen Items schreiben: der Lauf
    // HAT stattgefunden, nur gab es nichts Neues (max(fetchedAt) wäre dann
    // irreführend alt).
    const feedTenants = await prismaOwner.rssFeed.findMany({
      where: { active: true },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    const lastFetchAt = new Date().toISOString();
    for (const { tenantId } of feedTenants) {
      await prismaOwner.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: 'tax-news.last-fetch-at' } },
        update: { value: lastFetchAt },
        create: { tenantId, key: 'tax-news.last-fetch-at', value: lastFetchAt },
      });
    }

    log.info(
      { feeds: activeFeeds.length, fetched: all.length, inserted, notifications },
      'tax-news-fetch: done',
    );
    return { feeds: activeFeeds.length, fetched: all.length, inserted, notifications };
  },
  { connection, concurrency: 1 },
);

taxNewsFetchWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'tax-news-fetch failed');
});
