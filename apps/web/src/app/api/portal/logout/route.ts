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
import { log } from '@/server/logger';
import { relativeRedirect } from '@/server/http/relative-redirect';

function portalLoginResponse(): NextResponse {
  // Host-neutral wie /api/staff/force-logout (B-04).
  return relativeRedirect('/portal/login');
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
  } catch (error) {
    revocationFailed = true;
    // F-05: Der Widerruf aller Sitzungen ist sicherheitsrelevant; der Client
    // bekommt 503, das Log den Grund (ohne Kontakt-ID).
    log.warn(
      { component: 'portal-logout', err: (error as Error).message },
      'portal-logout: Sitzungswiderruf fehlgeschlagen',
    );
  }

  try {
    await portalSignOut({ redirect: false });
  } catch (error) {
    // Die explizite Cookie-Loeschung unten bleibt der ausfallsichere Pfad.
    log.warn(
      { component: 'portal-logout', err: (error as Error).message },
      'portal-logout: Auth.js-Abmeldung fehlgeschlagen, Cookies werden direkt gelöscht',
    );
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
