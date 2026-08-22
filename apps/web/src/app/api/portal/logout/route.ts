// =============================================================================
// POST /api/portal/logout
//
// Eigener, hosttreuer Logout-Endpunkt fuer das Mandantenportal. Eine normale
// HTML-Form bleibt auch ohne Client-JavaScript funktionsfaehig und umgeht die
// Origin-Validierung von Next.js-Server-Actions hinter Reverse-Proxies.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { portalSignOut } from '@/server/auth/portal';
import {
  PORTAL_SESSION_COOKIE_BASE,
  sessionCookieNameVariants,
  USE_SECURE_COOKIES,
} from '@/server/auth/session-cookie';

function portalCookieNames(req: NextRequest): Set<string> {
  const variants = sessionCookieNameVariants(PORTAL_SESSION_COOKIE_BASE);
  const names = new Set(variants);

  for (const cookie of req.cookies.getAll()) {
    if (
      variants.some(
        (base) =>
          cookie.name.startsWith(`${base}.`) && /^\d+$/.test(cookie.name.slice(base.length + 1)),
      )
    ) {
      names.add(cookie.name);
    }
  }

  return names;
}

function expirePortalSessionCookies(req: NextRequest, response: NextResponse): void {
  for (const name of portalCookieNames(req)) {
    const prefixedSecureCookie = name.startsWith('__Host-') || name.startsWith('__Secure-');
    response.cookies.set(name, '', {
      httpOnly: true,
      secure: USE_SECURE_COOKIES || prefixedSecureCookie,
      sameSite: 'lax',
      path: '/',
      expires: new Date(0),
      maxAge: 0,
      ...(!name.startsWith('__Host-') && env.PORTAL_COOKIE_DOMAIN
        ? { domain: env.PORTAL_COOKIE_DOMAIN }
        : {}),
    });
  }
}

function portalLoginResponse(): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: '/portal/login',
      'cache-control': 'no-store',
    },
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // SameSite=Lax haelt das Session-Cookie aus Cross-Site-POSTs heraus;
  // Fetch Metadata blockiert den Request zusaetzlich.
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: 'origin_mismatch' }, { status: 403 });
  }

  try {
    await portalSignOut({ redirect: false });
  } catch {
    // Die explizite Cookie-Loeschung unten bleibt der ausfallsichere Pfad.
  }

  // 303 stellt sicher, dass der Browser dem POST mit einem GET folgt.
  const response = portalLoginResponse();
  expirePortalSessionCookies(req, response);
  return response;
}
