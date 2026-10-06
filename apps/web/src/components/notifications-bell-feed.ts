'use client';
// =============================================================================
// Zähler und Kurzliste der Benachrichtigungsglocke (Review-Befund K-04).
//
// - P-08: Zählerabgleich über EINEN Poller pro Tab (lib/notification-count-
//   poller.ts): alle 30 s bei sichtbarem Tab, im Hintergrund pausiert; weitere
//   Abonnenten teilen sich jeden Abruf. Keine eigenen Timer.
// - Server-Refreshes liefern einen neuen Initialwert (Layout); eine
//   Navigation zählt sofort neu; lokale Gelesen-Änderungen laden die Liste.
// - Zuwachs (mehr ungelesene oder ein jüngerer Zeitpunkt) lädt EINMAL die
//   Kurzliste: eine auf der sichtbaren Zielseite schon dargestellte
//   Abschlussmeldung wird quittiert, sonst Ton, Hinweis, Live-Ereignis und —
//   nur wenn das Neue diese Seite betrifft oder sie live ist — ein Refresh.
//
// Die Callbacks bleiben über Renderings stabil (nur Pfad/Router ändern sie):
// sonst meldete sich die Glocke bei jedem Rendern am Poller ab und an, und
// dessen 30-s-Takt begänne jedes Mal neu.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useRouter } from 'next/navigation';
import { playNotificationSound } from '@/lib/notification-sound';
import {
  buildNotificationSignal,
  emitNotificationsGrew,
  onNotificationsChanged,
} from '@/lib/live-events';
import { shouldRefreshForNotifications } from '@/lib/live-refresh-policy';
import { notificationCountPoller, type UnreadSummary } from '@/lib/notification-count-poller';
import { isUserTyping } from './auto-refresh';
import { confirmRead } from './notifications-bell-ack';
import {
  advanceKnownUnread,
  completionToAcknowledge,
  growthTargets,
  knownUnread,
  newestUnread,
  unreadAfterRead,
  withAllRead,
  withItemRead,
  type NotificationItem,
  type RecentResponse,
} from './notifications-bell-model';

async function fetchRecent(): Promise<RecentResponse | null> {
  const res = await fetch('/api/staff/notifications/recent', { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as RecentResponse;
}

export function useNotificationFeed({
  initialUnread,
  initialLatestUnreadAt,
  pathname,
  router,
  onAlert,
}: {
  initialUnread: number;
  initialLatestUnreadAt: string | null;
  pathname: string;
  router: ReturnType<typeof useRouter>;
  /** Hinweis für den jüngsten ungelesenen Eintrag eines angekündigten Zuwachses (stabil). */
  onAlert: (item: NotificationItem) => void;
}) {
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [now, setNow] = useState(Date.now);
  // Zuletzt bekannter Stand (race-arm gegenüber parallelen Polls) — Quelle der
  // Wahrheit für die "es kam etwas Neues"-Erkennung (Ton + Live-Refresh). Eine
  // reine Anzahl reicht nicht: Wird eine alte Aufgabe geschlossen und
  // gleichzeitig eine neue erzeugt, bleibt sie gleich; der jüngste Zeitpunkt
  // ist die monotone zweite Signalkomponente.
  const knownRef = useRef(knownUnread(initialUnread, initialLatestUnreadAt));
  const [previousServerCount, setPreviousServerCount] = useState({
    initialUnread,
    initialLatestUnreadAt,
  });
  if (
    previousServerCount.initialUnread !== initialUnread ||
    previousServerCount.initialLatestUnreadAt !== initialLatestUnreadAt
  ) {
    setPreviousServerCount({ initialUnread, initialLatestUnreadAt });
    setUnread(initialUnread);
  }

  // Bei echtem Zuwachs die aktuelle Seite ereignisgetrieben aktualisieren —
  // aber nur, wenn das Neue diese Seite betrifft oder sie eine Live-Seite ist
  // (P-08, lib/live-refresh-policy.ts). Guards wie AutoRefresh: nicht bei
  // verstecktem Tab und nicht während der Nutzer tippt.
  // `previousLatestUnreadAt`: jüngster ungelesener Zeitpunkt VOR dem Zuwachs.
  const onUnreadGrew = useCallback(
    (previousLatestUnreadAt: number) => {
      // Die Kurzliste sagt, WEN der Zuwachs betrifft: nur die betroffenen
      // Blöcke laden dann nach (Mandanten-Cockpit). Sie landet gleich im
      // Dropdown-Zustand — ein späteres Öffnen zeigt sie ohne Roundtrip.
      void (async () => {
        try {
          const data = await fetchRecent();
          if (!data) throw new Error('NOTIFICATION_RECENT_FETCH_FAILED');
          setNow(Date.now());
          const completion = completionToAcknowledge(data.items, {
            pathname,
            hidden: document.hidden,
            typing: isUserTyping(),
          });
          if (completion && (await confirmRead(completion.id))) {
            const acknowledgedItems = withItemRead(
              data.items,
              completion.id,
              new Date().toISOString(),
            )!;
            const nextUnread = unreadAfterRead(data.unread);
            knownRef.current = { ...knownRef.current, unread: nextUnread };
            setUnread(nextUnread);
            setItems(acknowledgedItems);
            emitNotificationsGrew(buildNotificationSignal(acknowledgedItems));
            router.refresh();
            return;
          }

          setItems(data.items);
          playNotificationSound();
          const targets = growthTargets(data.items, previousLatestUnreadAt);
          if (
            shouldRefreshForNotifications(pathname, targets) &&
            !document.hidden &&
            !isUserTyping()
          ) {
            router.refresh();
          }
          const newest = newestUnread(data.items);
          if (newest) onAlert(newest);
          emitNotificationsGrew(buildNotificationSignal(data.items));
        } catch {
          // Der Detailabruf ist nur Zusatzkomfort. Ton + ggf. Refresh bleiben
          // erhalten, damit die Notification nicht still verloren geht (Ziele
          // unbekannt: Voll-Refresh nur auf Live-Seiten).
          playNotificationSound();
          if (shouldRefreshForNotifications(pathname, []) && !document.hidden && !isUserTyping()) {
            router.refresh();
          }
        }
      })();
    },
    [pathname, router, onAlert],
  );

  // Server-Refreshes (z. B. Formular auf /staff/notifications) liefern einen
  // neuen Initialwert. Auch dieser Pfad muss einen Alert auslösen können: Eine
  // eigene Server-Action refresht die Route oft schneller als der Poller.
  useEffect(() => {
    const step = advanceKnownUnread(knownRef.current, {
      unread: initialUnread,
      latestUnreadAt: initialLatestUnreadAt,
    });
    knownRef.current = step.known;
    if (step.grew) onUnreadGrew(step.previousLatestUnreadAt);
  }, [initialUnread, initialLatestUnreadAt, onUnreadGrew]);

  // Neuer Zählerstand (Poller oder Kurzliste): Ein höherer Zeitstempel erkennt
  // auch einen Austausch 1 offen → 1 offen. Genau dieser Fall ging beim reinen
  // Unread-Zähler verloren.
  const applyUnreadSummary = useCallback(
    (data: UnreadSummary) => {
      setNow(Date.now());
      const step = advanceKnownUnread(knownRef.current, data);
      knownRef.current = step.known;
      setUnread(data.unread);
      if (step.grew) onUnreadGrew(step.previousLatestUnreadAt);
    },
    [onUnreadGrew],
  );

  const refreshRecent = useCallback(() => {
    void (async () => {
      try {
        const data = await fetchRecent();
        if (!data) return;
        setItems(data.items);
        applyUnreadSummary(data);
      } catch {
        // silent
      }
    })();
  }, [applyUnreadSummary]);

  useEffect(() => onNotificationsChanged(refreshRecent), [refreshRecent]);

  useEffect(() => notificationCountPoller.subscribe(applyUnreadSummary), [applyUnreadSummary]);

  // Navigation rendert das Layout nicht neu: Zähler dann sofort abgleichen.
  // Beim ersten Mount hat das Layout ihn gerade serverseitig mitgeliefert.
  const countedPathnameRef = useRef(pathname);
  useEffect(() => {
    if (countedPathnameRef.current === pathname) return;
    countedPathnameRef.current = pathname;
    void notificationCountPoller.pollNow();
  }, [pathname]);

  return {
    unread,
    items,
    now,
    /** Relative Zeiten beim Öffnen auf den aktuellen Stand bringen. */
    touchNow: () => setNow(Date.now()),
    refreshRecent,
    /** Vom Server bestätigt gelesen: Liste und Zähler lokal nachziehen (F-01). */
    markReadLocally: (id: string) => {
      setItems((prev) => withItemRead(prev, id, new Date().toISOString()));
      setUnread((u) => {
        const next = unreadAfterRead(u);
        knownRef.current = { ...knownRef.current, unread: next };
        return next;
      });
    },
    markAllReadLocally: () => {
      setItems((prev) => withAllRead(prev, new Date().toISOString()));
      knownRef.current = { ...knownRef.current, unread: 0 };
      setUnread(0);
    },
  };
}
export type NotificationFeed = ReturnType<typeof useNotificationFeed>;
