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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

async function fetchRecent(signal: AbortSignal): Promise<RecentResponse> {
  const res = await fetch('/api/staff/notifications/recent', { cache: 'no-store', signal });
  if (!res.ok) throw new Error('NOTIFICATION_RECENT_FETCH_FAILED');
  return (await res.json()) as RecentResponse;
}

function visibleCompletion(items: NotificationItem[], pathname: string) {
  return completionToAcknowledge(items, {
    pathname,
    hidden: document.hidden,
    typing: isUserTyping(),
  });
}

function refreshVisiblePage(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  targets: Array<string | null>,
) {
  if (shouldRefreshForNotifications(pathname, targets) && !document.hidden && !isUserTyping()) {
    router.refresh();
  }
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  // Zuletzt bekannter Stand (race-arm gegenüber parallelen Polls) — Quelle der
  // Wahrheit für die "es kam etwas Neues"-Erkennung (Ton + Live-Refresh). Eine
  // reine Anzahl reicht nicht: Wird eine alte Aufgabe geschlossen und
  // gleichzeitig eine neue erzeugt, bleibt sie gleich; der jüngste Zeitpunkt
  // ist die monotone zweite Signalkomponente.
  const knownRef = useRef(knownUnread(initialUnread, initialLatestUnreadAt));
  const currentPath = useRef(pathname);
  const pending = useRef<{ controller: AbortController; since?: number } | null>(null);
  useLayoutEffect(() => {
    currentPath.current = pathname;
  }, [pathname]);
  useLayoutEffect(
    () => () => {
      pending.current?.controller.abort();
      pending.current = null;
    },
    [],
  );
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
  const loadRecent = useCallback(
    (previousLatestUnreadAt?: number) => {
      // Ein neuer Abruf ersetzt die alte Momentaufnahme, übernimmt aber einen
      // noch nicht angekündigten Zuwachs.
      const previous = pending.current;
      previous?.controller.abort();
      const request = {
        controller: new AbortController(),
        since: previous?.since ?? previousLatestUnreadAt,
      };
      pending.current = request;
      setLoadFailed(false);
      const { signal } = request.controller;
      void (async () => {
        try {
          const data = await fetchRecent(signal);
          if (signal.aborted) return;
          const step = advanceKnownUnread(knownRef.current, data);
          knownRef.current = step.known;
          setNow(Date.now());
          setUnread(data.unread);
          setItems(data.items);
          const since = request.since ?? (step.grew ? step.previousLatestUnreadAt : undefined);
          const newest = newestUnread(data.items);
          if (since === undefined || !newest) return;
          const completion = visibleCompletion(data.items, currentPath.current);
          const acknowledged = completion && (await confirmRead(completion.id).catch(() => false));
          if (signal.aborted) return;
          if (acknowledged) {
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
            if (visibleCompletion(data.items, currentPath.current)) router.refresh();
            return;
          }

          playNotificationSound();
          const targets = growthTargets(data.items, since);
          refreshVisiblePage(router, currentPath.current, targets);
          onAlert(newest);
          emitNotificationsGrew(buildNotificationSignal(data.items));
        } catch {
          if (signal.aborted) return;
          setLoadFailed(true);
          if (request.since === undefined) return;
          // Der Detailabruf ist nur Zusatzkomfort. Ton + ggf. Refresh bleiben
          // erhalten, damit die Notification nicht still verloren geht (Ziele
          // unbekannt: Voll-Refresh nur auf Live-Seiten).
          playNotificationSound();
          refreshVisiblePage(router, currentPath.current, []);
        } finally {
          if (pending.current === request) pending.current = null;
        }
      })();
    },
    [router, onAlert],
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
    if (step.grew) loadRecent(step.previousLatestUnreadAt);
  }, [initialUnread, initialLatestUnreadAt, loadRecent]);

  // Neuer Zählerstand (Poller oder Kurzliste): Ein höherer Zeitstempel erkennt
  // auch einen Austausch 1 offen → 1 offen. Genau dieser Fall ging beim reinen
  // Unread-Zähler verloren.
  const applyUnreadSummary = useCallback(
    (data: UnreadSummary) => {
      setNow(Date.now());
      const previousUnread = knownRef.current.unread;
      const step = advanceKnownUnread(knownRef.current, data);
      knownRef.current = step.known;
      setUnread(data.unread);
      if (step.grew) loadRecent(step.previousLatestUnreadAt);
      else if (pending.current && previousUnread !== data.unread) loadRecent();
    },
    [loadRecent],
  );

  const refreshRecent = useCallback(() => loadRecent(), [loadRecent]);

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
    loadFailed,
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
