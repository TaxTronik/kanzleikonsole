// =============================================================================
// CSRF-Defense-in-Depth: Origin-Check für cookie-authentifizierte POST-Routen.
//
// SameSite=lax auf den Session-Cookies blockiert klassisches Cross-Site-
// POSTing bereits — dieser Check ist die zweite Verteidigungslinie für die
// Fälle, in denen SameSite nicht greift (ältere Browser, Subdomain-
// Konstellationen, künftige Cookie-Änderungen). Browser senden bei POST den
// Origin-Header zuverlässig mit; fehlt er, muss Sec-Fetch-Site eindeutig
// same-origin/same-site/none sein. Fehlen beide Signale, blocken wir
// fail-closed.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';

/**
 * Prüft den Origin-Header eines (POST-)Requests gegen die erwartete
 * Basis-URL (Staff-Routen: env.NEXTAUTH_URL, Portal-Routen: portalBaseUrl).
 * Liefert bei Cross-Origin eine fertige 403-Response, sonst null
 * (Aufrufer fährt normal fort).
 */
export function assertSameOrigin(
  req: NextRequest,
  expectedBaseUrl: string,
): NextResponse | null {
  const mismatch = () =>
    NextResponse.json({ error: 'origin_mismatch' }, { status: 403 });

  const origin = req.headers.get('origin');
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      // Nicht parsebarer Origin (z. B. literal "null" aus sandboxed iframes
      // oder Redirect-Ketten) → wie Cross-Origin behandeln.
      return mismatch();
    }
    if (originUrl.origin === new URL(expectedBaseUrl).origin) return null;
    // Zweite legitime Referenz: der Request-Host (in Produktion vom
    // Reverse-Proxy gepinnt, siehe infra/nginx). Deckt Multi-Subdomain-/
    // Dev-Setups ab, deren Host nicht wörtlich in der env-URL steht — ein
    // CSRF-Origin (fremde Site) matched weder env-URL noch eigenen Host.
    const reqHost = (
      req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
    )
      .split(',')[0]!
      .trim()
      .toLowerCase();
    if (reqHost && originUrl.host.toLowerCase() === reqHost) return null;
    return mismatch();
  }

  // Kein Origin-Header: Browser senden ihn bei POST praktisch immer (auch
  // same-origin) — fehlt er, ist es ein älterer oder Nicht-Browser-Client.
  // Sec-Fetch-Site als zweites Signal; fehlt auch das, blocken wir.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none') {
    return null;
  }
  return mismatch();
}
