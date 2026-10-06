'use client';

import { useEffect, useState, useRef, useCallback, useId, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CheckCheck, X } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import {
  playNotificationSound,
  isNotificationSoundEnabled,
  setNotificationSoundEnabled,
} from '@/lib/notification-sound';
import {
  markNotificationReadByIdAction,
  markAllNotificationsReadAction,
} from '@/server/notifications/actions';
import { isUserTyping } from './auto-refresh';
import {
  buildNotificationSignal,
  emitNotificationsGrew,
  onNotificationsChanged,
} from '@/lib/live-events';
import {
  hasNewUnreadNotification,
  newUnreadNotifications,
  notificationTimestamp,
  shouldAcknowledgeCompletionOnCurrentPage,
} from '@/lib/notification-feed';
import { shouldRefreshForNotifications } from '@/lib/live-refresh-policy';
import { notificationCountPoller, type UnreadSummary } from '@/lib/notification-count-poller';
import { useAccessibleDisplayEnabled } from './accessible-display';
import { useAnchoredPanel } from './ui/use-anchored-panel';
import { scheduleNotificationAlertDismiss } from './ui/notification-alert-timing';

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
  readAt: string | null;
}

interface RecentResponse {
  items: NotificationItem[];
  unread: number;
  latestUnreadAt: string | null;
}

interface Props {
  initialUnread: number;
  initialLatestUnreadAt: string | null;
}

function relativeTime(iso: string, now: number): string {
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

const SOUND_EVENT = 'taxtronik:notification-sound';
function subscribeSoundPreference(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(SOUND_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(SOUND_EVENT, onChange);
  };
}

export function NotificationsBell({ initialUnread, initialLatestUnreadAt }: Props) {
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [alertItem, setAlertItem] = useState<NotificationItem | null>(null);
  const [open, setOpen] = useState(false);
  const soundOn = useSyncExternalStore(
    subscribeSoundPreference,
    isNotificationSoundEnabled,
    () => true,
  );
  const [alertHovered, setAlertHovered] = useState(false);
  const [alertFocused, setAlertFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const accessibleDisplay = useAccessibleDisplayEnabled();
  const panelStyle = useAnchoredPanel(open, containerRef, 384, 'end');
  // Zuletzt bekannter unread-Stand (race-arm gegenüber parallelen Polls) — Quelle
  // der Wahrheit für die "es kam etwas Neues"-Erkennung (Ton + Live-Refresh).
  const lastUnreadRef = useRef(initialUnread);
  // Eine reine Anzahl reicht nicht: Wird eine alte Aufgabe geschlossen und
  // gleichzeitig eine neue erzeugt, bleibt sie gleich. Der jüngste Zeitpunkt
  // ist deshalb die monotone zweite Signalkomponente.
  const latestUnreadAtRef = useRef(notificationTimestamp(initialLatestUnreadAt));
  const pathname = usePathname();
  const router = useRouter();
  const [now, setNow] = useState(Date.now);
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
  const [previousPathname, setPreviousPathname] = useState(pathname);
  if (previousPathname !== pathname) {
    setPreviousPathname(pathname);
    setOpen(false);
  }

  const showNotificationAlert = useCallback((item: NotificationItem) => {
    setAlertItem(item);
  }, []);

  useEffect(() => {
    if (!alertItem) return;
    return scheduleNotificationAlertDismiss({
      persistent: accessibleDisplay,
      interacting: alertHovered || alertFocused || open,
      dismiss: () => setAlertItem(null),
    });
  }, [alertItem, accessibleDisplay, alertHovered, alertFocused, open]);

  // Bei echtem Zuwachs an ungelesenen Benachrichtigungen (serverseitig ist etwas
  // passiert, z. B. Chain-Verify-Ergebnis) die aktuelle Seite ereignisgetrieben
  // aktualisieren — aber nur, wenn das Neue diese Seite betrifft oder sie eine
  // Live-Seite ist (P-08, lib/live-refresh-policy.ts). Guards wie AutoRefresh:
  // nicht bei verstecktem Tab und nicht während der Nutzer tippt.
  // `previousLatestUnreadAt`: jüngster ungelesener Zeitpunkt VOR dem Zuwachs.
  const onUnreadGrew = useCallback(
    (previousLatestUnreadAt: number) => {
      // Zusaetzlich melden — auch auf Seiten ohne Voll-Refresh (Mandanten-Cockpit).
      // Dafuer wird EINMAL die Kurzliste geladen, um zu erfahren, WEN der Zuwachs
      // betrifft: nur die betroffenen Bloecke laden dann nach. Ohne diese Angabe
      // wuerde jede Benachrichtigung jeden offenen Block anstossen, auch wenn sie
      // einen ganz anderen Mandanten betrifft.
      //
      // Die Kurzliste landet gleich im Dropdown-Zustand — ein spaeteres Oeffnen
      // zeigt sie ohne weiteren Roundtrip.
      void (async () => {
        try {
          const res = await fetch('/api/staff/notifications/recent', { cache: 'no-store' });
          if (!res.ok) throw new Error('NOTIFICATION_RECENT_FETCH_FAILED');
          const data = (await res.json()) as RecentResponse;
          setNow(Date.now());
          const newestUnread = data.items.find((item) => item.readAt === null);
          if (
            newestUnread &&
            !document.hidden &&
            !isUserTyping() &&
            shouldAcknowledgeCompletionOnCurrentPage({
              kind: newestUnread.kind,
              href: newestUnread.href,
              pathname,
            })
          ) {
            const acknowledged = await markNotificationReadByIdAction({ id: newestUnread.id });
            if (acknowledged.ok) {
              const readAt = new Date().toISOString();
              const acknowledgedItems = data.items.map((item) =>
                item.id === newestUnread.id ? { ...item, readAt } : item,
              );
              const nextUnread = Math.max(0, data.unread - 1);
              lastUnreadRef.current = nextUnread;
              setUnread(nextUnread);
              setItems(acknowledgedItems);
              emitNotificationsGrew(buildNotificationSignal(acknowledgedItems));
              router.refresh();
              return;
            }
          }

          setItems(data.items);
          playNotificationSound();
          const targets = newUnreadNotifications(data.items, previousLatestUnreadAt).map(
            (item) => item.href,
          );
          if (
            shouldRefreshForNotifications(pathname, targets) &&
            !document.hidden &&
            !isUserTyping()
          ) {
            router.refresh();
          }
          if (newestUnread) showNotificationAlert(newestUnread);
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
    [pathname, router, showNotificationAlert],
  );

  // Server-Refreshes (z. B. Formular auf /staff/notifications) liefern einen
  // neuen Initialwert. Auch dieser Pfad muss einen Alert auslösen können: Eine
  // eigene Server-Action refresht die Route oft schneller als der Poller.
  useEffect(() => {
    const previousLatestUnreadAt = latestUnreadAtRef.current;
    const grew = hasNewUnreadNotification({
      previousUnread: lastUnreadRef.current,
      previousLatestUnreadAt,
      nextUnread: initialUnread,
      nextLatestUnreadAt: initialLatestUnreadAt,
    });
    lastUnreadRef.current = initialUnread;
    latestUnreadAtRef.current = Math.max(
      previousLatestUnreadAt,
      notificationTimestamp(initialLatestUnreadAt),
    );
    if (grew) onUnreadGrew(previousLatestUnreadAt);
  }, [initialUnread, initialLatestUnreadAt, onUnreadGrew]);

  function toggleSound() {
    const next = !soundOn;
    setNotificationSoundEnabled(next);
    window.dispatchEvent(new Event(SOUND_EVENT));
    // Beim Aktivieren einmal probe-Play (gibt Nutzer:in direktes Feedback +
    // löst ggf. die Autoplay-Sperre durch die Nutzerinteraktion).
    if (next) playNotificationSound();
  }

  // Neuer Zählerstand (Poller oder Kurzliste): Ein höherer Zeitstempel erkennt
  // auch einen Austausch 1 offen → 1 offen. Genau dieser Fall ging beim reinen
  // Unread-Zähler verloren.
  const applyUnreadSummary = useCallback(
    (data: UnreadSummary) => {
      setNow(Date.now());
      const previousLatestUnreadAt = latestUnreadAtRef.current;
      const grew = hasNewUnreadNotification({
        previousUnread: lastUnreadRef.current,
        previousLatestUnreadAt,
        nextUnread: data.unread,
        nextLatestUnreadAt: data.latestUnreadAt,
      });
      lastUnreadRef.current = data.unread;
      latestUnreadAtRef.current = Math.max(
        previousLatestUnreadAt,
        notificationTimestamp(data.latestUnreadAt),
      );
      setUnread(data.unread);
      if (grew) onUnreadGrew(previousLatestUnreadAt);
    },
    [onUnreadGrew],
  );

  const refreshRecent = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch('/api/staff/notifications/recent', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as RecentResponse;
        setItems(data.items);
        applyUnreadSummary(data);
      } catch {
        // silent
      }
    })();
  }, [applyUnreadSummary]);

  useEffect(() => onNotificationsChanged(refreshRecent), [refreshRecent]);

  // P-08: Zählerabgleich über EINEN Poller pro Tab (lib/notification-count-
  // poller.ts): alle 30 s bei sichtbarem Tab, im Hintergrund pausiert; weitere
  // Abonnenten teilen sich jeden Abruf.
  useEffect(() => notificationCountPoller.subscribe(applyUnreadSummary), [applyUnreadSummary]);

  // Navigation rendert das Layout nicht neu: Zähler dann sofort abgleichen.
  // Beim ersten Mount hat das Layout ihn gerade serverseitig mitgeliefert.
  const countedPathnameRef = useRef(pathname);
  useEffect(() => {
    if (countedPathnameRef.current === pathname) return;
    countedPathnameRef.current = pathname;
    void notificationCountPoller.pollNow();
  }, [pathname]);

  // Klick außerhalb schließt das Dropdown
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && containerRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  function closePanel() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  function toggle() {
    const next = !open;
    setNow(Date.now());
    setOpen(next);
    if (next) refreshRecent();
  }

  async function handleItemClick(n: NotificationItem) {
    if (!n.readAt) {
      // Lokal nur als gelesen führen, was der Server bestätigt hat (Review-Befund F-01).
      const result = await markNotificationReadByIdAction({ id: n.id });
      if (!result.ok) return;
      setItems((prev) =>
        prev
          ? prev.map((p) => (p.id === n.id ? { ...p, readAt: new Date().toISOString() } : p))
          : prev,
      );
      setUnread((u) => {
        const next = Math.max(0, u - 1);
        lastUnreadRef.current = next;
        return next;
      });
    }
  }

  async function handleMarkAllRead() {
    const result = await markAllNotificationsReadAction(null, new FormData());
    if (!result.ok) return;
    setItems((prev) =>
      prev ? prev.map((p) => (p.readAt ? p : { ...p, readAt: new Date().toISOString() })) : prev,
    );
    lastUnreadRef.current = 0;
    setUnread(0);
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="relative p-2 text-muted hover:text-primary hover:bg-gray-100 rounded-md transition-colors"
        aria-label={unread > 0 ? `${unread} ungelesene Benachrichtigungen` : 'Benachrichtigungen'}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {alertItem && !open && (
        <div
          role="status"
          aria-live="polite"
          onMouseEnter={() => setAlertHovered(true)}
          onMouseLeave={() => setAlertHovered(false)}
          onFocusCapture={() => setAlertFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setAlertFocused(false);
          }}
          className="fixed right-4 top-16 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-brand-200 bg-surface p-4 shadow-xl dark:border-brand-800"
        >
          <div className="flex items-start gap-3">
            <Bell className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-primary">Neue Benachrichtigung</p>
              <p
                className={`mt-0.5 text-sm text-secondary ${accessibleDisplay ? 'break-words' : 'truncate'}`}
              >
                {alertItem.title}
              </p>
              {alertItem.href && (
                <Link
                  href={alertItem.href}
                  onClick={() => {
                    setAlertItem(null);
                    void handleItemClick(alertItem);
                  }}
                  className="mt-2 inline-block text-sm text-brand-700 hover:underline dark:text-brand-500"
                >
                  Öffnen →
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setAlertItem(null);
                triggerRef.current?.focus({ preventScroll: true });
              }}
              className="rounded p-1 text-muted hover:bg-gray-100 hover:text-primary"
              aria-label="Hinweis schließen"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={`${panelId}-heading`}
          tabIndex={-1}
          style={panelStyle}
          className="absolute z-30 rounded-lg shadow-lg border border-default bg-surface overflow-y-auto overscroll-contain"
        >
          <div className="px-4 py-3 border-b border-default flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${panelId}-heading`} className="text-sm font-medium text-primary">
              Benachrichtigungen
              {unread > 0 && <span className="ml-2 text-xs text-muted">({unread} neu)</span>}
            </h3>
            {unread > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-brand-700 dark:text-brand-500 hover:underline inline-flex items-center gap-1"
              >
                <CheckCheck className="h-3 w-3" aria-hidden="true" />
                Alle gelesen
              </button>
            )}
            <button
              type="button"
              onClick={closePanel}
              className="ml-auto rounded p-2 text-muted hover:bg-gray-100 hover:text-primary"
              aria-label="Benachrichtigungen schließen"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div>
            {items === null ? (
              <p role="status" className="px-4 py-8 text-sm text-disabled text-center">
                Lade…
              </p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-sm text-disabled text-center">
                Keine Benachrichtigungen.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {items.map((n) => {
                  const inner = (
                    <div className="flex items-start gap-2 px-4 py-3 hover:bg-gray-50">
                      {!n.readAt && (
                        <span
                          aria-hidden="true"
                          className="mt-1.5 inline-block w-2 h-2 rounded-full bg-brand-600 shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p
                          className={`${n.readAt ? 'text-sm text-secondary' : 'text-sm font-medium text-primary'} ${accessibleDisplay ? 'break-words' : 'truncate'}`}
                        >
                          {!n.readAt && <span className="sr-only">Ungelesen. </span>}
                          {n.title}
                        </p>
                        {n.body && (
                          <p
                            className={
                              accessibleDisplay
                                ? 'text-sm text-muted whitespace-pre-wrap break-words'
                                : 'text-xs text-muted line-clamp-2'
                            }
                          >
                            {n.body}
                          </p>
                        )}
                        <time
                          dateTime={n.createdAt}
                          title={fmtDateTimeShort(new Date(n.createdAt))}
                          className={`block text-muted mt-0.5 ${accessibleDisplay ? 'text-sm' : 'text-xs'}`}
                        >
                          {relativeTime(n.createdAt, now)}
                        </time>
                      </div>
                    </div>
                  );
                  return n.href ? (
                    <li key={n.id}>
                      <Link href={n.href} onClick={() => handleItemClick(n)} className="block">
                        {inner}
                      </Link>
                    </li>
                  ) : (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => handleItemClick(n)}
                        className="w-full text-left"
                      >
                        {inner}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-default px-4 py-2 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={soundOn}
                onChange={toggleSound}
                className="rounded border-default"
              />
              Ton bei neuen Benachrichtigungen
            </label>
            <Link
              href="/staff/notifications"
              onClick={closePanel}
              className="text-xs text-brand-700 dark:text-brand-500 hover:underline shrink-0"
            >
              Alle anzeigen →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
