// =============================================================================
// POST /api/portal/logout
//
// Eigener, hosttreuer Logout-Endpunkt fuer das Mandantenportal. Eine normale
// HTML-Form bleibt auch ohne Client-JavaScript funktionsfaehig und umgeht die
// Origin-Validierung von Next.js-Server-Actions, die hinter Reverse-Proxies
// einen Logout bereits vor der eigentlichen Action verwerfen kann.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { portalSignOut } from '@/server/auth/portal';
import {
  PORTAL_SESSION_COOKIE_BASE,
  sessionCookieNameVariants,
} from '@/server/auth/session-cookie';

function expirePortalSessionCookies(response: NextResponse): void {
  for (const name of sessionCookieNameVariants(PORTAL_SESSION_COOKIE_BASE)) {
    response.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: new Date(0),
      maxAge: 0,
      ...(env.PORTAL_COOKIE_DOMAIN ? { domain: env.PORTAL_COOKIE_DOMAIN } : {}),
    });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // SameSite=Lax haelt das Session-Cookie aus Cross-Site-POSTs heraus;
  // Fetch Metadata blockiert den Request zusaetzlich. Anders als die globale
  // Origin-Pruefung bleibt dieser Endpoint damit auch hinter Proxies nutzbar,
  // die den Origin-/Forwarded-Host fuer Form-Navigationen umschreiben.
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'origin_mismatch' }, { status: 403 });
  }

  try {
    await portalSignOut({ redirect: false });
  } catch {
    // Die explizite Cookie-Loeschung unten bleibt der ausfallsichere Pfad.
  }

  // 303 ist fuer einen POST-Logout wichtig: der Browser folgt dem Redirect
  // mit GET, statt den POST gegen /portal/login zu wiederholen.
  const response = NextResponse.redirect(new URL('/portal/login', req.url), 303);
  response.headers.set('cache-control', 'no-store');
  expirePortalSessionCookies(response);
  return response;
}
