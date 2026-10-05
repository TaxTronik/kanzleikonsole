// =============================================================================
// GET/POST /api/staff/force-logout
//
// Selbstheilung fuer ungueltige „Geister“-Sessions und expliziter Logout fuer
// den Staff-Bereich. GET bleibt fuer den Redirect aus dem geschuetzten Layout,
// der sichtbare Abmelden-Button verwendet POST.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { staffSessionSubject, staffSignOut } from '@/server/auth/staff';
import { revokeAllSessions } from '@/server/auth/revocation';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import { staffSessionFactory } from '@/server/auth/staff-session';

function staffLoginResponse(): NextResponse {
  // Relative Location ist absichtlich host-neutral: req.url kann hinter einem
  // Reverse-Proxy die interne Adresse (z. B. https://0.0.0.0:3000) enthalten.
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: '/staff/login',
      'cache-control': 'no-store',
    },
  });
}

async function logout(req: NextRequest, revoke: boolean): Promise<NextResponse> {
  let revocationFailed = false;
  if (revoke) {
    try {
      const staffId = await staffSessionSubject();
      if (staffId) {
        await revokeAllSessions('staff', staffId);
      }
    } catch {
      revocationFailed = true;
    }
  }

  try {
    await staffSignOut({ redirect: false });
  } catch {
    // Die explizite Cookie-Loeschung unten bleibt der ausfallsichere Pfad.
  }

  const response = revocationFailed
    ? NextResponse.json(
        { error: 'session_revocation_unavailable' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    : staffLoginResponse();
  // Alle Namensvarianten samt Auth.js-Chunks (Session-Fabrik, S-05).
  staffSessionFactory.expire(req, response);
  return response;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // GET dient ausschliesslich der lokalen Cookie-Selbstheilung. Ein fremd
  // initiierter GET darf niemals einen globalen Session-Cutoff schreiben.
  return logout(req, false);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;
  return logout(req, true);
}
