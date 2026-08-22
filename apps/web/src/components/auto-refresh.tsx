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

export const REFRESH_INTERVAL_MS = 120_000;

const STAFF_CLIENT_DETAIL_PATH =
  /^\/staff\/clients\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/gwg)?\/?$/i;

/**
 * Zentrale Route-Policy fuer automatische Voll-Refreshes. Teure Seiten koennen
 * hier gezielt pausiert werden, ohne das Polling in den Layouts zu duplizieren.
 */
export function isAutomaticRefreshEnabled(pathname: string): boolean {
  if (pathname.startsWith('/staff/admin/audit')) return false;
  // Das Mandanten-Cockpit laedt viele unabhaengige Bloecke und bis zu 1.000
  // Dokumente; die GwG-Pruefseite laedt den kompletten Pruefsnapshot und ist
  // voller Formulare, die ihren Zustand per Action-Payload abgleichen. Dort
  // bleiben manuelle Refreshes und Server-Action-Revalidierung verfuegbar,
  // periodische/Bell-getriebene Voll-Refreshes sind aber pausiert.
  return !STAFF_CLIENT_DETAIL_PATH.test(pathname);
}

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

  useEffect(() => {
    if (!isAutomaticRefreshEnabled(pathname)) return;

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
