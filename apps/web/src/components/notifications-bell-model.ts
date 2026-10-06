// =============================================================================
// Reine Regeln der Benachrichtigungsglocke (Review-Befund K-04): Zuwachs-
// erkennung gegen den zuletzt bekannten Stand, Auswahl der zu quittierenden
// Abschlussmeldung, Ziele eines Zuwachses, lokales Gelesen-Markieren und die
// relative Zeitangabe. Ohne React, ohne Netz — die Hooks
// (notifications-bell-feed.ts, notifications-bell-ack.ts) führen sie aus.
// =============================================================================

import { fmtDateTimeShort } from '@/lib/fmt';
import {
  hasNewUnreadNotification,
  newUnreadNotifications,
  notificationTimestamp,
  shouldAcknowledgeCompletionOnCurrentPage,
} from '@/lib/notification-feed';
import type { UnreadSummary } from '@/lib/notification-count-poller';

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface RecentResponse {
  items: NotificationItem[];
  unread: number;
  latestUnreadAt: string | null;
}

/** Zuletzt bekannter Stand: Anzahl und jüngster ungelesener Zeitpunkt (ms). */
export interface KnownUnread {
  unread: number;
  latestUnreadAt: number;
}

export function knownUnread(unread: number, latestUnreadAt: string | null): KnownUnread {
  return { unread, latestUnreadAt: notificationTimestamp(latestUnreadAt) };
}

/**
 * Neuer Zählerstand gegen den bekannten: Zuwachs (mehr ungelesene ODER ein
 * jüngerer Zeitpunkt — erkennt auch den Austausch 1 offen → 1 offen) und der
 * fortgeschriebene Stand. Der Zeitpunkt wird nie zurückgesetzt.
 */
export function advanceKnownUnread(
  known: KnownUnread,
  next: UnreadSummary,
): { known: KnownUnread; grew: boolean; previousLatestUnreadAt: number } {
  const grew = hasNewUnreadNotification({
    previousUnread: known.unread,
    previousLatestUnreadAt: known.latestUnreadAt,
    nextUnread: next.unread,
    nextLatestUnreadAt: next.latestUnreadAt,
  });
  return {
    grew,
    previousLatestUnreadAt: known.latestUnreadAt,
    known: {
      unread: next.unread,
      latestUnreadAt: Math.max(known.latestUnreadAt, notificationTimestamp(next.latestUnreadAt)),
    },
  };
}

export function newestUnread(items: readonly NotificationItem[]): NotificationItem | undefined {
  return items.find((item) => item.readAt === null);
}

/**
 * Abschlussmeldung, die die sichtbare Zielseite bereits darstellt: wird
 * quittiert statt angekündigt — nie bei verborgenem Tab oder während der
 * Nutzer tippt.
 */
export function completionToAcknowledge(
  items: readonly NotificationItem[],
  context: { pathname: string; hidden: boolean; typing: boolean },
): NotificationItem | null {
  const newest = newestUnread(items);
  if (!newest || context.hidden || context.typing) return null;
  return shouldAcknowledgeCompletionOnCurrentPage({
    kind: newest.kind,
    href: newest.href,
    pathname: context.pathname,
  })
    ? newest
    : null;
}

/** Ziele der seit `previousLatestUnreadAt` neuen ungelesenen Einträge (Refresh-Politik). */
export function growthTargets(
  items: readonly NotificationItem[],
  previousLatestUnreadAt: number,
): Array<string | null> {
  return newUnreadNotifications(items, previousLatestUnreadAt).map((item) => item.href);
}

export function withItemRead(
  items: NotificationItem[] | null,
  id: string,
  readAt: string,
): NotificationItem[] | null {
  return items ? items.map((item) => (item.id === id ? { ...item, readAt } : item)) : items;
}

export function withAllRead(
  items: NotificationItem[] | null,
  readAt: string,
): NotificationItem[] | null {
  return items ? items.map((item) => (item.readAt ? item : { ...item, readAt })) : items;
}

/** Ein bestätigt gelesener Eintrag weniger, nie unter null. */
export function unreadAfterRead(unread: number): number {
  return Math.max(0, unread - 1);
}

export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  const diff = now - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
  return fmtDateTimeShort(new Date(t));
}
