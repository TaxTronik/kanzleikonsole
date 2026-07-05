'use client';

// =============================================================================
// AutoRefresh — leichtgewichtige "Live"-Aktualisierung für Server-Component-
// Daten. Ruft periodisch router.refresh() auf, sobald der Tab sichtbar ist und
// der Nutzer gerade NICHT in einem Eingabefeld tippt (Formulareingaben,
// Server-Actions und Modale werden so nicht gestört).
//
// Kein WebSocket/SSE — bewusst ein einfacher Polling-Refresh, der status quo auf
// allen Seiten frische Daten bringt, ohne die Eingabe zu unterbrechen.
// =============================================================================

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * True, wenn der Nutzer gerade in einem Eingabefeld tippt — dann darf kein
 * router.refresh() dazwischenfunken (Formulare/Modals würden gestört).
 * Auch von der Notifications-Bell genutzt (Notification-getriebener Refresh).
 */
export function isUserTyping(): boolean {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (ae as HTMLElement).isContentEditable;
}

export function AutoRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname.startsWith('/staff/admin/audit')) return;

    function tick(): void {
      // Nur refreshen, wenn der Tab sichtbar ist und der Nutzer nicht gerade
      // tippt — sonst gäbe es Störungen bei Formularen / offenen Modals.
      if (!document.hidden && !isUserTyping()) {
        router.refresh();
      }
    }

    const timer = setInterval(tick, REFRESH_INTERVAL_MS);
    // Beim Zurückkommen auf den Tab sofort einmal aktualisieren.
    function onVisible() {
      if (!document.hidden) tick();
    }
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pathname, router]);
  return null;
}
