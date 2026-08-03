// =============================================================================
// Browser-Ereignis „es gibt neue Benachrichtigungen" — mit Angabe, WEN es angeht.
//
// Die Notifications-Bell pollt ohnehin und weiss als Erste, dass serverseitig
// etwas passiert ist. Bisher zog sie daraus nur einen `router.refresh()` — und
// genau der ist auf dem Mandanten-Cockpit bewusst abgeschaltet (die Seite laedt
// viele Bloecke und bis zu 1.000 Dokumente, siehe auto-refresh.tsx). Folge:
// eine frisch delegierte Wiedervorlage tauchte dort erst nach manuellem Reload
// auf.
//
// Statt die teure Ausnahme aufzuweichen, meldet die Bell dieses Ereignis —
// samt der betroffenen Mandanten-IDs. Ein offener Block laedt nur dann nach,
// wenn es SEINEN Mandanten betrifft; eine Benachrichtigung zu einem anderen
// Mandanten kostet ihn gar nichts.
// =============================================================================

export const NOTIFICATIONS_GREW_EVENT = 'taxtronik:notifications-grew';

export interface NotificationSignal {
  /** Mandanten, die von den neuen Benachrichtigungen betroffen sind. */
  clientIds: string[];
  /** NotificationKind-Werte — für Abonnenten, die feiner filtern wollen. */
  kinds: string[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLIENT_HREF = new RegExp(`^/staff/clients/(${UUID})(?:[/?#]|$)`, 'i');

/**
 * Zieht die Mandanten-ID aus dem Ziel-Link einer Benachrichtigung.
 *
 * Die Benachrichtigung traegt kein eigenes Mandantenfeld, wohl aber den Link,
 * auf den sie zeigt — und der beginnt bei allen mandantenbezogenen Arten mit
 * `/staff/clients/<id>`. Alles andere (Dashboard, Systemmeldungen, Portal)
 * liefert null und loest damit kein Nachladen aus.
 */
export function clientIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = CLIENT_HREF.exec(href);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Baut das Signal aus den (ungelesenen) Benachrichtigungen der Bell. */
export function buildNotificationSignal(
  items: ReadonlyArray<{ href?: string | null; kind?: string | null; readAt?: string | null }>,
): NotificationSignal {
  const clientIds = new Set<string>();
  const kinds = new Set<string>();
  for (const i of items) {
    // Gelesene Eintraege sind alt — sie sagen nichts ueber den Zuwachs aus.
    if (i.readAt) continue;
    const cid = clientIdFromHref(i.href);
    if (cid) clientIds.add(cid);
    if (i.kind) kinds.add(i.kind);
  }
  return { clientIds: [...clientIds], kinds: [...kinds] };
}

/** Von der Notifications-Bell aufgerufen, sobald die Ungelesen-Zahl steigt. */
export function emitNotificationsGrew(signal: NotificationSignal): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_GREW_EVENT, { detail: signal }));
}

/**
 * Abonniert das Ereignis. Gibt die Abmeldefunktion zurueck (fuer useEffect).
 *
 * `clientId` filtert auf den eigenen Mandanten: ohne Treffer passiert nichts.
 * Feuert nur bei sichtbarem Tab — Nachladen im Hintergrund waere verschwendete
 * Last, und beim Zurueckkehren pollt die Bell ohnehin sofort.
 */
export function onNotificationsGrew(
  handler: (signal: NotificationSignal) => void,
  options: { clientId?: string } = {},
): () => void {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (e: Event) => {
    if (document.hidden) return;
    const signal = (e as CustomEvent<NotificationSignal>).detail ?? { clientIds: [], kinds: [] };
    if (options.clientId && !signal.clientIds.includes(options.clientId.toLowerCase())) return;
    handler(signal);
  };
  window.addEventListener(NOTIFICATIONS_GREW_EVENT, wrapped);
  return () => window.removeEventListener(NOTIFICATIONS_GREW_EVENT, wrapped);
}
