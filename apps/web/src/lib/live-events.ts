// =============================================================================
// Browser-Ereignis „es gibt neue Benachrichtigungen".
//
// Die Notifications-Bell pollt ohnehin und weiss als Erste, dass serverseitig
// etwas passiert ist. Bisher zog sie daraus nur einen `router.refresh()` — und
// genau der ist auf dem Mandanten-Cockpit bewusst abgeschaltet (die Seite laedt
// viele Bloecke und bis zu 1.000 Dokumente, siehe auto-refresh.tsx). Folge:
// eine frisch delegierte Wiedervorlage tauchte dort erst nach manuellem Reload
// auf.
//
// Statt die teure Ausnahme aufzuweichen, sendet die Bell zusaetzlich dieses
// Ereignis. Einzelne, guenstige Bloecke koennen sich daraufhin GEZIELT
// nachladen (ein kleiner GET), ohne dass die ganze Seite neu rendert.
// =============================================================================

export const NOTIFICATIONS_GREW_EVENT = 'taxtronik:notifications-grew';

/** Von der Notifications-Bell aufgerufen, sobald die Ungelesen-Zahl steigt. */
export function emitNotificationsGrew(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_GREW_EVENT));
}

/**
 * Abonniert das Ereignis. Gibt die Abmeldefunktion zurueck (fuer useEffect).
 * Feuert nur bei sichtbarem Tab — ein Nachladen im Hintergrund waere
 * verschwendete Last, und beim Zurueckkehren pollt die Bell ohnehin sofort.
 */
export function onNotificationsGrew(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const wrapped = () => {
    if (!document.hidden) handler();
  };
  window.addEventListener(NOTIFICATIONS_GREW_EVENT, wrapped);
  return () => window.removeEventListener(NOTIFICATIONS_GREW_EVENT, wrapped);
}
