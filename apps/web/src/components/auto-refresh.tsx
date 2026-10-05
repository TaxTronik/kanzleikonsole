'use client';

// =============================================================================
// AutoRefresh — "Live"-Aktualisierung für Server-Component-Daten.
//
// Opt-in (Review-Befund P-08): Nur auf den Seiten aus LIVE_REFRESH_ROUTES
// (lib/live-refresh-policy.ts, je Route begründet) ruft die Komponente alle
// 120 s router.refresh() auf, solange der Tab sichtbar ist und niemand in ein
// Eingabefeld tippt. Im Hintergrund pausiert der Takt; nach der Rückkehr lädt
// sie nur dann sofort neu, wenn der Tab mindestens 60 s verborgen war. Alle
// übrigen Seiten aktualisieren sich über Server-Actions, gezielte Refreshes der
// Glocke bei neuen Benachrichtigungen oder blockweises Nachladen.
//
// Unabhängig davon erzwingt die Komponente auf JEDER Seite einen Reload, wenn
// der Browser sie aus dem Back/Forward-Cache wiederherstellt (Auth-Prüfung).
// =============================================================================

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  REFRESH_INTERVAL_MS,
  RESUME_REFRESH_AFTER_HIDDEN_MS,
  isAutomaticRefreshEnabled,
} from '@/lib/live-refresh-policy';
import { notificationCountPoller } from '@/lib/notification-count-poller';
import { startVisibilityInterval, type VisibilitySource } from '@/lib/visibility-interval';

/**
 * True, wenn der Nutzer gerade in einem Eingabefeld tippt — dann darf kein
 * router.refresh() dazwischenfunken (Formulare/Modals würden gestört).
 * Auch von der Notifications-Bell genutzt (Notification-getriebener Refresh).
 */
export function isUserTyping(): boolean {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName ?? '').toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (ae as HTMLElement).isContentEditable
  );
}

export function shouldReloadRestoredPage(persisted: boolean): boolean {
  return persisted;
}

/**
 * Startet den periodischen Refresh für `pathname` und liefert die Abmeldung.
 * Für Routen ohne Live-Zustand passiert nichts. Ohne React testbar (Takt,
 * Sichtbarkeit und Tippen werden injiziert).
 */
export function startAutoRefresh(input: {
  pathname: string;
  refresh: () => void;
  isTyping?: () => boolean;
  source?: VisibilitySource;
  now?: () => number;
}): () => void {
  if (!isAutomaticRefreshEnabled(input.pathname)) return () => {};
  const isTyping = input.isTyping ?? isUserTyping;
  const schedule = startVisibilityInterval({
    intervalMs: REFRESH_INTERVAL_MS,
    resumeAfterHiddenMs: RESUME_REFRESH_AFTER_HIDDEN_MS,
    source: input.source,
    now: input.now,
    onTick: () => {
      if (!isTyping()) input.refresh();
    },
  });
  return () => schedule.stop();
}

export function AutoRefresh() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function onPageShow(event: PageTransitionEvent): void {
      // Browser koennen selbst no-store-Seiten aus dem Back/Forward Cache als
      // alten Snapshot zeigen. Nach einem Logout wuerde dadurch wieder die
      // geschuetzte Ansicht erscheinen. Ein Reload erzwingt die Auth-Pruefung.
      if (shouldReloadRestoredPage(event.persisted)) {
        window.location.reload();
      }
    }

    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  useEffect(
    () =>
      startAutoRefresh({
        pathname,
        refresh: () => {
          router.refresh();
          // Das Staff-Layout liest beim Refresh den Glocken-Zähler mit; die
          // Glocke muss ihn dann nicht zusätzlich abfragen.
          notificationCountPoller.markFresh();
        },
      }),
    [pathname, router],
  );
  return null;
}
