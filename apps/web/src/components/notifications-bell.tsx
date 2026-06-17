'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';
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
}

interface Props {
  initialUnread: number;
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

export function NotificationsBell({ initialUnread }: Props) {
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(true);
  const pathname = usePathname();
  const now = Date.now();

  useEffect(() => {
    setSoundOn(isNotificationSoundEnabled());
  }, []);

  function toggleSound() {
    const next = !soundOn;
    setSoundOn(next);
    setNotificationSoundEnabled(next);
    // Beim Aktivieren einmal probe-Play (gibt Nutzer:in direktes Feedback +
    // löst ggf. die Autoplay-Sperre durch die Nutzerinteraktion).
    if (next) playNotificationSound();
  }

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/staff/notifications/count', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { unread: number };
      // Funktionaler Update + Delta-Check: nur bei echtem Zuwachs Ton, und
      // robust gegen zwei parallel laufende Polls (vorher: Klammergriff auf
      // veraltetem `unread`).
      setUnread((prev) => {
        if (data.unread > prev) playNotificationSound();
        return data.unread;
      });
    } catch {
      // silent
    }
  }, []);

  const refreshRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/staff/notifications/recent', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as RecentResponse;
      setItems(data.items);
      setUnread((prev) => {
        if (data.unread > prev) playNotificationSound();
        return data.unread;
      });
    } catch {
      // silent
    }
  }, []);

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
        prev ? prev.map((p) => (p.id === n.id ? { ...p, readAt: new Date().toISOString() } : p)) : prev,
      );
      setUnread((u) => Math.max(0, u - 1));
    }
  }

  async function handleMarkAllRead() {
    await markAllNotificationsReadAction();
    setItems((prev) =>
      prev ? prev.map((p) => (p.readAt ? p : { ...p, readAt: new Date().toISOString() })) : prev,
    );
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

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-96 max-w-[calc(100vw-2rem)] z-30 rounded-lg shadow-lg border border-default bg-surface overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-default flex items-center justify-between">
            <h3 className="text-sm font-medium text-primary">
              Benachrichtigungen
              {unread > 0 && (
                <span className="ml-2 text-xs text-muted">({unread} neu)</span>
              )}
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
              <p className="px-4 py-8 text-sm text-disabled text-center">Keine Benachrichtigungen.</p>
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
                        {n.body && (
                          <p className="text-xs text-muted line-clamp-2">{n.body}</p>
                        )}
                        <p className="text-[10px] text-disabled mt-0.5">{relativeTime(n.createdAt, now)}</p>
                      </div>
                    </div>
                  );
                  return n.href ? (
                    <li key={n.id}>
                      <Link
                        href={n.href}
                        onClick={() => handleItemClick(n)}
                        className="block"
                      >
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
