import type { ReactNode } from 'react';
// =============================================================================
// RSS-Reader-Widget (BMF/BFH und beliebige weitere Feeds).
//
// Eigene Klick-Logik weil es kein einfaches ListShell-Pattern ist
// (custom Header mit RssReaderManage + TaxNewsToggle).
// =============================================================================

import { ExternalLink, Newspaper } from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { RssReaderManage } from '../rss-reader-manage';
import { TaxNewsToggle } from '../tax-news-toggle';
import { BookmarkButton } from '../bookmark-button';
import type { RenderCtx } from './_shared';

function feedBadgeClass(color: string | null): string {
  switch (color) {
    case 'blue':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200';
    case 'purple':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200';
    case 'green':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
    case 'amber':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
    case 'pink':
      return 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200';
    case 'slate':
      return 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200';
    default:
      return 'bg-gray-100 text-primary';
  }
}

export async function TaxNews({ tx, staffId, isAdmin }: RenderCtx): Promise<ReactNode> {
  const [feeds, staff, bookmarks] = await Promise.all([
    tx.rssFeed.findMany({
      where: { staffId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, url: true, color: true, active: true },
    }),
    tx.staffUser.findUnique({
      where: { id: staffId },
      select: { taxNewsNotify: true },
    }),
    tx.staffBookmark.findMany({
      where: { staffId, resourceType: 'tax_news_item' },
      select: { resourceId: true },
    }),
  ]);

  const activeUrls = feeds
    .filter((f: { active: boolean }) => f.active)
    .map((f: { url: string }) => f.url);

  const feedByUrl = new Map<string, { name: string; color: string | null }>();
  for (const f of feeds as Array<{ url: string; name: string; color: string | null }>) {
    feedByUrl.set(f.url, { name: f.name, color: f.color });
  }

  const items =
    activeUrls.length === 0
      ? []
      : await tx.taxNewsItem.findMany({
          where: { source: { in: activeUrls } },
          orderBy: [{ publishedAt: 'desc' }, { fetchedAt: 'desc' }],
          take: 20,
        });
  const bookmarkedIds = new Set<string>(bookmarks.map((b: { resourceId: string }) => b.resourceId));

  return (
    <div className="card h-full flex flex-col">
      <div className="px-5 py-3 border-b border-default flex items-center justify-between gap-2 shrink-0 relative">
        <h2 className="text-sm font-medium text-primary flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-disabled" />
          RSS-Reader
        </h2>
        <div className="flex items-center gap-1 relative">
          <RssReaderManage
            feeds={(
              feeds as Array<{
                id: string;
                name: string;
                url: string;
                color: string | null;
                active: boolean;
              }>
            ).map((f) => ({
              id: f.id,
              name: f.name,
              url: f.url,
              color: f.color,
              active: f.active,
            }))}
          />
          <TaxNewsToggle
            enabled={Boolean(staff?.taxNewsNotify)}
            canTriggerFetch={Boolean(isAdmin)}
          />
        </div>
      </div>
      {activeUrls.length === 0 ? (
        <div className="px-5 py-8 text-sm text-disabled text-center flex-1">
          Keine aktiven Feeds. Über das Zahnrad oben einen Feed hinzufügen oder BMF/BFH-Defaults
          wiederherstellen.
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8 text-sm text-disabled text-center flex-1">
          Noch keine Einträge. Der Worker zieht die Feeds täglich morgens; Admins können über das
          Glocken-Icon manuell aktualisieren.
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {items.map(
            (n: {
              id: string;
              source: string;
              title: string;
              link: string;
              publishedAt: Date | null;
              fetchedAt: Date;
            }) => {
              const feedMeta = feedByUrl.get(n.source);
              const label = feedMeta?.name ?? '?';
              const color = feedMeta?.color ?? null;
              return (
                <li key={n.id} className="px-5 py-2.5 flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <a
                      href={n.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block hover:bg-gray-50 -ml-5 pl-5 -mr-2 pr-2 py-1 rounded"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-primary line-clamp-2 flex-1">
                          {n.title}
                        </p>
                        <ExternalLink className="h-3 w-3 text-disabled shrink-0 mt-1" />
                      </div>
                      <p className="text-xs text-muted mt-0.5">
                        <span
                          className={
                            'inline-block rounded px-1.5 py-0.5 mr-1.5 text-[10px] font-medium ' +
                            feedBadgeClass(color)
                          }
                        >
                          {label}
                        </span>
                        {n.publishedAt
                          ? fmtDateShort(n.publishedAt)
                          : `Gefunden ${fmtDateShort(n.fetchedAt)}`}
                      </p>
                    </a>
                  </div>
                  <BookmarkButton
                    resourceType="tax_news_item"
                    resourceId={n.id}
                    label={`${label}: ${n.title}`}
                    href={n.link}
                    initiallyBookmarked={bookmarkedIds.has(n.id)}
                  />
                </li>
              );
            },
          )}
        </ul>
      )}
    </div>
  );
}
