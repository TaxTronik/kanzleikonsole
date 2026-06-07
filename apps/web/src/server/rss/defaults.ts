// =============================================================================
// Default-RSS-Feeds, die bei der Anlage eines neuen Mitarbeiters automatisch
// angelegt werden. Ursprung: iter36_rss_feeds-Migration (dort für bestehende
// Staff geseedet). Der BMF-Feed wurde später vom Aktuelles- auf den Steuern-
// Feed umgestellt — bestehende Staff übernehmen ihn via „Defaults wiederherstellen".
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';

export const DEFAULT_RSS_FEEDS: Array<{ name: string; url: string; color: string; sortOrder: number }> = [
  {
    name: 'BMF',
    url: 'https://www.bundesfinanzministerium.de/SiteGlobals/Functions/RSSFeed/DE/Steuern/RSSSteuern.xml',
    color: 'blue',
    sortOrder: 10,
  },
  {
    name: 'BFH',
    url: 'https://www.bundesfinanzhof.de/de/precedent.rss',
    color: 'purple',
    sortOrder: 20,
  },
];

export async function seedDefaultRssFeeds(
  tx: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  staffId: string,
): Promise<void> {
  for (const f of DEFAULT_RSS_FEEDS) {
    try {
      await tx.rssFeed.create({
        data: { tenantId, staffId, name: f.name, url: f.url, color: f.color, sortOrder: f.sortOrder },
      });
    } catch (e) {
      // P2002 = (staffId, url) bereits vorhanden — idempotent, ignorieren
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }
}
