'use client';
// =============================================================================
// Quittieren in der Benachrichtigungsglocke (Review-Befund K-04).
//
// Lokal wird nur als gelesen geführt, was der Server bestätigt hat
// (Review-Befund F-01): erst die Server-Action, dann Liste und Zähler. Die
// automatische Quittung einer Abschlussmeldung auf ihrer sichtbaren Zielseite
// nutzt dieselbe Bestätigung (notifications-bell-feed.ts).
// =============================================================================

import {
  markAllNotificationsReadAction,
  markNotificationReadByIdAction,
} from '@/server/notifications/actions';
import type { NotificationItem } from './notifications-bell-model';

/** Einen Eintrag serverseitig als gelesen markieren; `true` nur bei Bestätigung. */
export async function confirmRead(id: string): Promise<boolean> {
  const result = await markNotificationReadByIdAction({ id });
  return result.ok;
}

/** Alle Einträge serverseitig als gelesen markieren; `true` nur bei Bestätigung. */
export async function confirmAllRead(): Promise<boolean> {
  const result = await markAllNotificationsReadAction(null, new FormData());
  return result.ok;
}

export function useNotificationAcknowledgement(feed: {
  markReadLocally: (id: string) => void;
  markAllReadLocally: () => void;
}) {
  return {
    /** Klick auf einen Eintrag (Liste oder Hinweis): ungelesene quittieren. */
    markRead: async (item: NotificationItem) => {
      if (item.readAt) return;
      if (!(await confirmRead(item.id))) return;
      feed.markReadLocally(item.id);
    },
    markAllRead: async () => {
      if (!(await confirmAllRead())) return;
      feed.markAllReadLocally();
    },
  };
}
