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

export function AutoRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname.startsWith('/staff/admin/audit')) return;

    function isTyping(): boolean {
      const ae = document.activeElement;
      if (!ae) return false;
      const tag = (ae.tagName ?? '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || (ae as HTMLElement).isContentEditable === true;
    }

    function tick(): void {
      // Nur refreshen, wenn der Tab sichtbar ist und der Nutzer nicht gerade
      // tippt — sonst gäbe es Störungen bei Formularen / offenen Modals.
      if (!document.hidden && !isTyping()) {
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
