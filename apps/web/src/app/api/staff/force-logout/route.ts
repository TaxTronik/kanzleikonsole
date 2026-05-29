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
  try {
    // Auth.js löscht die (ggf. gechunkten) Session-Cookies sauber.
    await staffSignOut({ redirect: false });
  } catch {
    // Selbst wenn signOut scheitert: trotzdem zum Login leiten.
  }
  return NextResponse.redirect(new URL('/staff/login', req.url));
}
