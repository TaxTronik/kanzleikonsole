// =============================================================================
// Welche Seiten lädt der Browser von sich aus neu? (Review-Befund P-08)
//
// Vorher galt Opt-out: AutoRefresh lud jede Seite alle 120 s und bei jeder
// Rückkehr in den Tab komplett neu, ausgenommen nur Mandanten-Cockpit, dessen
// GwG-Seite und Audit. Damit liefen auch GwG-Kontrollliste, Posteingang,
// Jahreswechsel und Admin-Übersicht regelmäßig vollständig neu.
//
// Jetzt gilt Opt-in in zwei Stufen:
//   1. Periodisch (alle 120 s, bei Rückkehr nach ≥ 60 s Abwesenheit) nur die
//      Seiten in LIVE_REFRESH_ROUTES: Live-Zustand, den andere ändern, ohne dass
//      der Betrachter davon benachrichtigt wird, bei begrenzter Renderlast.
//   2. Ereignisgetrieben (Glocke meldet NEUE Benachrichtigungen): zusätzlich
//      die Seite, auf die eine neue Benachrichtigung zeigt (bzw. deren Liste),
//      und die Benachrichtigungsliste selbst. Cockpit, GwG-Seite und Audit
//      bleiben ausgenommen; dort laden betroffene Blöcke selbst nach
//      (`onNotificationsGrew`, z. B. RemindersBlock) bzw. eigene Poller.
// =============================================================================

export const REFRESH_INTERVAL_MS = 120_000;
/** Rückkehr in den Tab: erst nach so langer Abwesenheit sofort neu laden. */
export const RESUME_REFRESH_AFTER_HIDDEN_MS = 60_000;

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

export interface LiveRefreshRoute {
  pattern: RegExp;
  /** Begründung aus dem Code: was ändert sich hier ohne Zutun des Betrachters? */
  reason: string;
}

export const LIVE_REFRESH_ROUTES: readonly LiveRefreshRoute[] = [
  {
    pattern: /^\/staff\/dashboard\/?$/,
    reason:
      'Startseite: Widgets (Arbeitskorb, Wiedervorlagen, Termine, Anforderungen) ändern sich ' +
      'durch Kollegen, Mandanten und Hintergrundjobs ohne Benachrichtigung an den Betrachter; ' +
      'Widget-Abfragen sind begrenzt und laufen mit höchstens 4 parallelen Transaktionen.',
  },
  {
    pattern: /^\/staff\/work\/?$/,
    reason:
      'Arbeitskorb: Einträge werden durch Zeitablauf fällig/überfällig und durch Delegation ' +
      'neu zugeordnet; höchstens 200 Einträge.',
  },
  {
    pattern: /^\/staff\/admin\/jobs\/?$/,
    reason:
      'Job-Monitor: Warteschlangen- und Laufstatus der Hintergrundjobs ändern sich laufend, ' +
      'ohne Benachrichtigung; nur Redis-Zähler, keine DB-Last.',
  },
  {
    pattern: /^\/portal\/dashboard\/?$/,
    reason:
      'Portal-Startseite: offene Anforderungen, Formulare und Rechnungen legt die Kanzlei an. ' +
      'Das Portal hat keine Glocke, der Refresh ist der einzige Aktualisierungsweg; ' +
      'Zähler plus höchstens 10/5 Zeilen je Liste.',
  },
  {
    pattern: new RegExp(`^/portal/inbox(?:/${UUID})?/?$`, 'i'),
    reason:
      'Portal-Nachrichten und -Verlauf: Antworten der Kanzlei erscheinen ohne Glocke nur per ' +
      'Refresh; seitenweise Liste bzw. ein einzelner Thread.',
  },
];

// Nie per Benachrichtigung voll neu laden: Cockpit (viele Blöcke, Dokumente),
// GwG-Prüfseite (Prüfsnapshot, Formularzustand) und Audit (eigene Poller).
const NO_FULL_REFRESH_ROUTES: readonly RegExp[] = [
  new RegExp(`^/staff/clients/${UUID}(?:/gwg)?/?$`, 'i'),
  /^\/staff\/admin\/audit(?:\/|$)/,
];

function normalizedPath(value: string | null | undefined): string | null {
  if (!value?.startsWith('/') || value.startsWith('//')) return null;
  const path = value.split(/[?#]/, 1)[0]!.replace(/\/+$/, '');
  return path || '/';
}

/** Periodischer Refresh (AutoRefresh) für diese Route? */
export function isAutomaticRefreshEnabled(pathname: string): boolean {
  return LIVE_REFRESH_ROUTES.some((route) => route.pattern.test(pathname));
}

/**
 * Betrifft eine Benachrichtigung mit Ziel `href` die angezeigte Seite? Ja, wenn
 * sie genau hierhin zeigt oder unterhalb dieser Seite (Liste → Detail), z. B.
 * `/staff/requests` bei einer Antwort auf `/staff/requests/<id>`.
 */
export function notificationTargetsPage(
  href: string | null | undefined,
  pathname: string,
): boolean {
  const target = normalizedPath(href);
  const page = normalizedPath(pathname);
  if (!target || !page || page.split('/').length < 3) return false;
  return target === page || target.startsWith(`${page}/`);
}

/**
 * Soll die Glocke nach neuen Benachrichtigungen (mit diesen Zielen) die ganze
 * Seite neu laden? `targetHrefs` leer = Ziele unbekannt (Abruf fehlgeschlagen).
 */
export function shouldRefreshForNotifications(
  pathname: string,
  targetHrefs: ReadonlyArray<string | null | undefined>,
): boolean {
  if (isAutomaticRefreshEnabled(pathname)) return true;
  const page = normalizedPath(pathname) ?? pathname;
  if (NO_FULL_REFRESH_ROUTES.some((route) => route.test(page))) return false;
  if (page === '/staff/notifications') return targetHrefs.length > 0;
  return targetHrefs.some((href) => notificationTargetsPage(href, page));
}
