'use client';
// =============================================================================
// Hinweis „Neue Benachrichtigung“ der Glocke (Review-Befund K-04).
//
// Die Lesefrist hängt am Profilmodus und an der Interaktion, nicht an Ton oder
// Fachlogik: regulär 8 s, im Profilmodus ohne automatisches Schließen; Zeiger,
// Tastaturfokus oder das geöffnete Dropdown halten sie an. Der Zustand liegt in
// der Glocke (useNotificationAlert), damit er erhalten bleibt, während das
// Dropdown den Hinweis verdeckt.
// =============================================================================

import { useCallback, useEffect, useState, type FocusEvent } from 'react';
import Link from 'next/link';
import { Bell, X } from 'lucide-react';
import { scheduleNotificationAlertDismiss } from './ui/notification-alert-timing';
import type { NotificationItem } from './notifications-bell-model';

export function useNotificationAlert({
  persistent,
  open,
}: {
  /** Profilmodus: kein automatisches Schließen. */
  persistent: boolean;
  /** Dropdown geöffnet: Hinweis verdeckt, Lesefrist pausiert. */
  open: boolean;
}) {
  const [item, setItem] = useState<NotificationItem | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  // Stabil: die Glocke reicht ihn an den Zähler-Hook weiter (Poller-Abonnement).
  const show = useCallback((next: NotificationItem) => {
    setItem(next);
  }, []);

  useEffect(() => {
    if (!item) return;
    return scheduleNotificationAlertDismiss({
      persistent,
      interacting: hovered || focused || open,
      dismiss: () => setItem(null),
    });
  }, [item, persistent, hovered, focused, open]);

  return {
    item,
    show,
    dismiss: () => setItem(null),
    interactionHandlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocusCapture: () => setFocused(true),
      onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      },
    },
  };
}
export type NotificationAlertState = ReturnType<typeof useNotificationAlert>;

export function NotificationAlert({
  item,
  accessibleDisplay,
  interactionHandlers,
  onOpen,
  onClose,
}: {
  item: NotificationItem;
  accessibleDisplay: boolean;
  interactionHandlers: NotificationAlertState['interactionHandlers'];
  /** „Öffnen →“: Hinweis schließen und den Eintrag quittieren. */
  onOpen: () => void;
  /** Schließen-Knopf: Hinweis schließen, Fokus zurück an die Glocke. */
  onClose: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      {...interactionHandlers}
      className="fixed right-4 top-16 z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-brand-200 bg-surface p-4 shadow-xl dark:border-brand-800"
    >
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-primary">Neue Benachrichtigung</p>
          <p
            className={`mt-0.5 text-sm text-secondary ${accessibleDisplay ? 'break-words' : 'truncate'}`}
          >
            {item.title}
          </p>
          {item.href && (
            <Link
              href={item.href}
              onClick={onOpen}
              className="mt-2 inline-block text-sm text-brand-700 hover:underline dark:text-brand-500"
            >
              Öffnen →
            </Link>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-gray-100 hover:text-primary"
          aria-label="Hinweis schließen"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
