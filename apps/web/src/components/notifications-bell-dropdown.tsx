'use client';
// =============================================================================
// Dropdown der Benachrichtigungsglocke (Review-Befund K-04): benannter,
// nichtmodaler Dialog mit Kurzliste, „Alle gelesen“, Ton-Schalter und Link zur
// Übersicht. Klick außerhalb, Escape (Fokus zurück an die Glocke) und ein
// Seitenwechsel schließen ihn; beim Öffnen erhält der Dialog den Fokus. Der
// ganze Feed bleibt samt Kopf und Fuß im sichtbaren Bereich scrollbar.
// =============================================================================

import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import Link from 'next/link';
import { CheckCheck, X } from 'lucide-react';
import { fmtDateTimeShort } from '@/lib/fmt';
import { relativeTime, type NotificationItem } from './notifications-bell-model';

export function useNotificationsDropdown({
  pathname,
  containerRef,
  triggerRef,
  panelRef,
}: {
  pathname: string;
  containerRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [previousPathname, setPreviousPathname] = useState(pathname);
  if (previousPathname !== pathname) {
    setPreviousPathname(pathname);
    setOpen(false);
  }

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
  }, [open, containerRef, triggerRef]);

  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open, panelRef]);

  return {
    open,
    setOpen,
    focusTrigger: () => triggerRef.current?.focus({ preventScroll: true }),
    /** Schließen-Knopf und „Alle anzeigen“: schließen, Fokus zurück an die Glocke. */
    close: () => {
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    },
  };
}

export function NotificationsDropdown({
  panelId,
  panelRef,
  panelStyle,
  unread,
  items,
  now,
  accessibleDisplay,
  soundOn,
  onToggleSound,
  onMarkAllRead,
  onItemClick,
  onClose,
}: {
  panelId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  panelStyle: CSSProperties | undefined;
  unread: number;
  items: NotificationItem[] | null;
  now: number;
  accessibleDisplay: boolean;
  soundOn: boolean;
  onToggleSound: () => void;
  onMarkAllRead: () => void;
  onItemClick: (item: NotificationItem) => void;
  onClose: () => void;
}) {
  return (
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
            onClick={onMarkAllRead}
            className="text-xs text-brand-700 dark:text-brand-500 hover:underline inline-flex items-center gap-1"
          >
            <CheckCheck className="h-3 w-3" aria-hidden="true" />
            Alle gelesen
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
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
          <p className="px-4 py-8 text-sm text-disabled text-center">Keine Benachrichtigungen.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {items.map((n) => (
              <NotificationEntry
                key={n.id}
                item={n}
                now={now}
                accessibleDisplay={accessibleDisplay}
                onClick={() => onItemClick(n)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-default px-4 py-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={soundOn}
            onChange={onToggleSound}
            className="rounded border-default"
          />
          Ton bei neuen Benachrichtigungen
        </label>
        <Link
          href="/staff/notifications"
          onClick={onClose}
          className="text-xs text-brand-700 dark:text-brand-500 hover:underline shrink-0"
        >
          Alle anzeigen →
        </Link>
      </div>
    </div>
  );
}

function NotificationEntry({
  item: n,
  now,
  accessibleDisplay,
  onClick,
}: {
  item: NotificationItem;
  now: number;
  accessibleDisplay: boolean;
  onClick: () => void;
}) {
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
    <li>
      <Link href={n.href} onClick={onClick} className="block">
        {inner}
      </Link>
    </li>
  ) : (
    <li>
      <button type="button" onClick={onClick} className="w-full text-left">
        {inner}
      </button>
    </li>
  );
}
