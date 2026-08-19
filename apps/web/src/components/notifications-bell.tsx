'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
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
  markNotificationReadAction,
  markAllNotificationsReadAction,
} from '@/app/staff/(protected)/notifications/actions';
import { isAutomaticRefreshEnabled, isUserTyping } from './auto-refresh';
import {
  buildNotificationSignal,
  emitNotificationsGrew,
  onNotificationsChanged,
} from '@/lib/live-events';
import { hasNewUnreadNotification, notificationTimestamp } from '@/lib/notification-feed';

const POLL_INTERVAL_MS = 30_000;

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

export function NotificationsBell({ initialUnread, initialLatestUnreadAt }: Props) {
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [alertItem, setAlertItem] = useState<NotificationItem | null>(null);
  const [open, setOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(true);
  // Zuletzt bekannter unread-Stand (race-arm gegenüber parallelen Polls) — Quelle
  // der Wahrheit für die "es kam etwas Neues"-Erkennung (Ton + Live-Refresh).
  const lastUnreadRef = useRef(initialUnread);
  // Eine reine Anzahl reicht nicht: Wird eine alte Aufgabe geschlossen und
  // gleichzeitig eine neue erzeugt, bleibt sie gleich. Der jüngste Zeitpunkt
  // ist deshalb die monotone zweite Signalkomponente.
  const latestUnreadAtRef = useRef(notificationTimestamp(initialLatestUnreadAt));
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const now = Date.now();

  const showNotificationAlert = useCallback((item: NotificationItem) => {
    setAlertItem(item);
    if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    alertTimerRef.current = setTimeout(() => setAlertItem(null), 8000);
  }, []);

  // Bei echtem Zuwachs an ungelesenen Benachrichtigungen (serverseitig ist etwas
  // passiert, z. B. Chain-Verify-Ergebnis) die aktuelle Seite ereignisgetrieben
  // aktualisieren — sonst blieben Server-Component-Inhalte bis zum nächsten
  // manuellen Reload stehen. Guards wie AutoRefresh: nicht bei verstecktem Tab
  // und nicht während der Nutzer tippt.
  const onUnreadGrew = useCallback(() => {
    playNotificationSound();
    if (isAutomaticRefreshEnabled(pathname) && !document.hidden && !isUserTyping()) {
      router.refresh();
    }
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
        if (!res.ok) return;
        const data = (await res.json()) as RecentResponse;
        setItems(data.items);
        const newestUnread = data.items.find((item) => item.readAt === null);
        if (newestUnread) showNotificationAlert(newestUnread);
        emitNotificationsGrew(buildNotificationSignal(data.items));
      } catch {
        // still — beim naechsten Zuwachs erneut
      }
    })();
  }, [pathname, router, showNotificationAlert]);

  useEffect(
    () => () => {
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setSoundOn(isNotificationSoundEnabled());
  }, []);

  // Server-Refreshes (z. B. Formular auf /staff/notifications) liefern einen
  // neuen Initialwert. Auch dieser Pfad muss einen Alert auslösen können: Eine
  // eigene Server-Action refresht die Route oft schneller als der Poller.
  useEffect(() => {
    const grew = hasNewUnreadNotification({
      previousUnread: lastUnreadRef.current,
      previousLatestUnreadAt: latestUnreadAtRef.current,
      nextUnread: initialUnread,
      nextLatestUnreadAt: initialLatestUnreadAt,
    });
    lastUnreadRef.current = initialUnread;
    latestUnreadAtRef.current = Math.max(
      latestUnreadAtRef.current,
      notificationTimestamp(initialLatestUnreadAt),
    );
    setUnread(initialUnread);
    if (grew) onUnreadGrew();
  }, [initialUnread, initialLatestUnreadAt, onUnreadGrew]);

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    setNotificationSoundEnabled(next);
    // Beim Aktivieren einmal probe-Play (gibt Nutzer:in direktes Feedback +
    // löst ggf. die Autoplay-Sperre durch die Nutzerinteraktion).
    if (next) playNotificationSound();
  }

  const refreshCount = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch('/api/staff/notifications/count', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          unread: number;
          latestUnreadAt: string | null;
        };
        const latestUnreadAt = notificationTimestamp(data.latestUnreadAt);
        // Ein höherer Zeitstempel erkennt auch einen Austausch 1 offen → 1
        // offen. Genau dieser Fall ging beim reinen Unread-Zähler verloren.
        const grew = hasNewUnreadNotification({
          previousUnread: lastUnreadRef.current,
          previousLatestUnreadAt: latestUnreadAtRef.current,
          nextUnread: data.unread,
          nextLatestUnreadAt: data.latestUnreadAt,
        });
        lastUnreadRef.current = data.unread;
        latestUnreadAtRef.current = Math.max(latestUnreadAtRef.current, latestUnreadAt);
        setUnread(data.unread);
        if (grew) onUnreadGrew();
      } catch {
        // silent
      }
    })();
  }, [onUnreadGrew]);

  const refreshRecent = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch('/api/staff/notifications/recent', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as RecentResponse;
        setItems(data.items);
        const latestUnreadAt = notificationTimestamp(data.latestUnreadAt);
        const grew = hasNewUnreadNotification({
          previousUnread: lastUnreadRef.current,
          previousLatestUnreadAt: latestUnreadAtRef.current,
          nextUnread: data.unread,
          nextLatestUnreadAt: data.latestUnreadAt,
        });
        lastUnreadRef.current = data.unread;
        latestUnreadAtRef.current = Math.max(latestUnreadAtRef.current, latestUnreadAt);
        setUnread(data.unread);
        if (grew) onUnreadGrew();
      } catch {
        // silent
      }
    })();
  }, [onUnreadGrew]);

  useEffect(() => onNotificationsChanged(refreshRecent), [refreshRecent]);

  useEffect(() => {
    function onVisibility() {
      visibleRef.current = !document.hidden;
      if (!document.hidden) refreshCount();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refreshCount]);

  useEffect(() => {
    const id = setInterval(() => {
      if (visibleRef.current) refreshCount();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshCount]);

  useEffect(() => {
    refreshCount();
    setOpen(false);
  }, [pathname, refreshCount]);

  // Klick außerhalb schließt das Dropdown
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) refreshRecent();
  }

  async function handleItemClick(n: NotificationItem) {
    if (!n.readAt) {
      const fd = new FormData();
      fd.append('id', n.id);
      await markNotificationReadAction(fd);
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
    await markAllNotificationsReadAction();
    setItems((prev) =>
      prev ? prev.map((p) => (p.readAt ? p : { ...p, readAt: new Date().toISOString() })) : prev,
    );
    lastUnreadRef.current = 0;
    setUnread(0);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        className="relative p-2 text-muted hover:text-primary hover:bg-gray-100 rounded-md transition-colors"
        aria-label={unread > 0 ? `${unread} ungelesene Benachrichtigungen` : 'Benachrichtigungen'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {alertItem && (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-4 top-16 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-brand-200 bg-surface p-4 shadow-xl dark:border-brand-800"
        >
          <div className="flex items-start gap-3">
            <Bell className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-primary">Neue Benachrichtigung</p>
              <p className="mt-0.5 truncate text-sm text-secondary">{alertItem.title}</p>
              {alertItem.href && (
                <Link
                  href={alertItem.href}
                  onClick={() => {
                    setAlertItem(null);
                    void handleItemClick(alertItem);
                  }}
                  className="mt-2 inline-block text-xs text-brand-700 hover:underline dark:text-brand-500"
                >
                  Öffnen →
                </Link>
              )}
            </div>
            <button
              type="button"
              onClick={() => setAlertItem(null)}
              className="rounded p-1 text-muted hover:bg-gray-100 hover:text-primary"
              aria-label="Hinweis schließen"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-96 max-w-[calc(100vw-2rem)] z-30 rounded-lg shadow-lg border border-default bg-surface overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-default flex items-center justify-between">
            <h3 className="text-sm font-medium text-primary">
              Benachrichtigungen
              {unread > 0 && <span className="ml-2 text-xs text-muted">({unread} neu)</span>}
            </h3>
            {unread > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-brand-700 dark:text-brand-500 hover:underline inline-flex items-center gap-1"
              >
                <CheckCheck className="h-3 w-3" />
                Alle gelesen
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items === null ? (
              <p className="px-4 py-8 text-sm text-disabled text-center">Lade…</p>
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
                        <span className="mt-1.5 inline-block w-2 h-2 rounded-full bg-brand-600 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p
                          className={
                            n.readAt
                              ? 'text-sm text-secondary truncate'
                              : 'text-sm font-medium text-primary truncate'
                          }
                        >
                          {n.title}
                        </p>
                        {n.body && <p className="text-xs text-muted line-clamp-2">{n.body}</p>}
                        <p className="text-[10px] text-disabled mt-0.5">
                          {relativeTime(n.createdAt, now)}
                        </p>
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

          <div className="border-t border-default px-4 py-2 flex items-center justify-between gap-2">
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
              onClick={() => setOpen(false)}
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
