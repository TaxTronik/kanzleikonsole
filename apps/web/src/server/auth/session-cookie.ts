// =============================================================================
// Session-Cookie-Namen (Staff + Portal) — Single Source of Truth.
//
// Härtung: __Host-/__Secure-Präfix nach Auth.js-Standardmuster, NUR wenn das
// Cookie `secure` ausgestellt wird (Production) — im HTTP-Dev lehnen Browser
// Präfix-Cookies ab, dort bleibt der bisherige unpräfixte Name.
//   - KEINE Cookie-Domain konfiguriert (Default, host-only) → `__Host-`:
//     Browser erzwingen Secure + Path=/ + kein Domain-Attribut; das Cookie
//     kann nicht von Subdomains oder unsicheren Kontexten überschrieben
//     werden (Session-Fixation via Sibling-Subdomain ausgeschlossen).
//   - Cookie-Domain gesetzt (Subdomain-Trennung, STAFF_/PORTAL_COOKIE_DOMAIN)
//     → `__Secure-`: __Host- wäre mit Domain-Attribut ungültig.
// Die Cookie-OPTIONEN (secure/path/domain) stehen weiterhin in staff.ts /
// portal.ts und passen zu dieser Wahl (secure nur prod; domain nur wenn env
// gesetzt; path '/').
//
// ROLLOUT-HINWEIS: die Namensänderung in Produktion invalidiert bestehende
// Sessions (einmaliges Re-Login) — akzeptiert.
//
// Bewusst OHNE @taxtronik/config-Import: proxy.ts (Middleware-Bundle) braucht
// die Namen ebenfalls und soll die Zod-Env-Validierung nicht ins Proxy-Bundle
// ziehen (proxy.ts liest auch sonst direkt aus process.env). Die Werte sind
// identisch zu env.STAFF_/PORTAL_COOKIE_DOMAIN (gleiche Quelle, leerer String
// zählt wie in env.ts als „nicht gesetzt").
// =============================================================================

const IS_PROD = process.env.NODE_ENV === 'production';

function sessionCookieName(base: string, cookieDomain: string | undefined): string {
  if (!IS_PROD) return `__${base}`; // Dev (HTTP): Browser lehnen Präfix-Cookies ab
  return cookieDomain ? `__Secure-${base}` : `__Host-${base}`;
}

export const STAFF_SESSION_COOKIE = sessionCookieName(
  'taxtronik_staff_session',
  process.env['STAFF_COOKIE_DOMAIN'] || undefined,
);

export const PORTAL_SESSION_COOKIE = sessionCookieName(
  'taxtronik_portal_session',
  process.env['PORTAL_COOKIE_DOMAIN'] || undefined,
);
