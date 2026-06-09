// =============================================================================
// GET /api/staff/force-logout
//
// Selbstheilung für ungültige/„Geister"-Sessions: Wenn ein Staff-Session-Cookie
// vorhanden ist, die Session aber nicht (mehr) gültig ist (User/Tenant existiert
// nicht — z. B. nach DB-Reset/Re-Seed), leitet das geschützte Layout hierher um.
// Wir LÖSCHEN das Cookie aktiv (statt es nur zu ignorieren) und schicken zum
// Login. Damit kann sich kein Browser dauerhaft auf ein totes Cookie verklemmen
// (z. B. wenn ein neues Cookie das alte nicht zuverlässig ersetzt).
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { staffSignOut } from '@/server/auth/staff';

export async function GET(req: NextRequest) {
  // GET bleibt bewusst GET: einziger Aufrufer ist der redirect() aus
  // staff/(protected)/layout.tsx — eine Browser-Navigation, kein fetch/form.
  //
  // Logout-CSRF-Härtung: die Route ändert Zustand (Cookie-Löschung). Eine
  // cross-site initiierte Navigation (Link/<img> von fremder Seite) darf das
  // nicht auslösen → ohne signOut nur zum Login leiten (kein Zustandswechsel,
  // gleiche Außenwirkung wie ein abgelaufenes Cookie). same-origin/same-site/
  // none (eigene Redirects, Adresszeile, Bookmarks) und fehlender Header
  // (ältere Clients) bleiben erlaubt.
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.redirect(new URL('/staff/login', req.url));
  }
  try {
    // Auth.js löscht die (ggf. gechunkten) Session-Cookies sauber.
    await staffSignOut({ redirect: false });
  } catch {
    // Selbst wenn signOut scheitert: trotzdem zum Login leiten.
  }
  return NextResponse.redirect(new URL('/staff/login', req.url));
}
