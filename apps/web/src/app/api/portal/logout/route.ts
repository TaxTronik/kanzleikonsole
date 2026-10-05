// =============================================================================
// POST /api/portal/logout
//
// Eigener, hosttreuer Logout-Endpunkt fuer das Mandantenportal. Eine normale
// HTML-Form bleibt auch ohne Client-JavaScript funktionsfaehig und umgeht die
// Origin-Validierung von Next.js-Server-Actions hinter Reverse-Proxies.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { portalBaseUrl } from '@taxtronik/config';
import { portalSessionSubject, portalSignOut } from '@/server/auth/portal';
import { revokeAllSessions } from '@/server/auth/revocation';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { portalSessionFactory } from '@/server/auth/portal-session';

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
  const csrf = assertSameOrigin(req, portalBaseUrl);
  if (csrf) return csrf;

  let revocationFailed = false;
  try {
    const contactId = await portalSessionSubject();
    if (contactId) {
      await revokeAllSessions('portal', contactId);
    }
  } catch {
    revocationFailed = true;
  }

  try {
    await portalSignOut({ redirect: false });
  } catch {
    // Die explizite Cookie-Loeschung unten bleibt der ausfallsichere Pfad.
  }

  // 303 stellt sicher, dass der Browser dem POST mit einem GET folgt.
  const response = revocationFailed
    ? NextResponse.json(
        { error: 'session_revocation_unavailable' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    : portalLoginResponse();
  // Alle Namensvarianten samt Auth.js-Chunks (Session-Fabrik, S-05).
  portalSessionFactory.expire(req, response);
  return response;
}
