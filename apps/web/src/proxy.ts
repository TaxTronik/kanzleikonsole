// =============================================================================
// taxtronik — Next.js Proxy (vormals: middleware)
//
// Seit Next.js 16 heißt das Convention-File `proxy.ts` statt `middleware.ts`.
// Verhalten ist identisch.
//
// Verantwortlichkeiten:
//   1. Pfad-basiertes Auth-Surface-Routing (/staff/* vs /portal/*)
//   2. Session-Validierung pro Surface (separate Cookies, separate Auth.js-Instanzen)
//   3. Redirect zur richtigen Login-Seite, falls keine Session
//   4. Tenant-Resolution (Subdomain → tenant_slug → tenant_id) und Weitergabe
//      via Request-Header an Server Components / Route Handlers
//   5. Request-ID-Vergabe für strukturiertes Logging
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';

const STAFF_PATH_PREFIX = '/staff';
const PORTAL_PATH_PREFIX = '/portal';
const STAFF_LOGIN_PATH = '/staff/login';
const PORTAL_LOGIN_PATH = '/portal/login';

const STAFF_SESSION_COOKIE = '__taxtronik_staff_session';
const PORTAL_SESSION_COOKIE = '__taxtronik_portal_session';

// Host→Surface (Multi-Domain-Deploy). PORTAL_PUBLIC_URL = Mandanten-Domain,
// NEXTAUTH_URL = Kanzlei/Staff-Domain. Wird einmal beim Worker-Start aus den
// (Compose-injizierten) ENV gelesen. Wenn PORTAL_PUBLIC_URL leer ist
// (Single-Host-Deploy), bleibt das Verhalten unverändert (kein Host-Routing).
function hostOf(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}
const PORTAL_HOST = hostOf(process.env['PORTAL_PUBLIC_URL']);
const STAFF_HOST = hostOf(process.env['NEXTAUTH_URL']);

// Pfade, die ohne Session erreichbar sein müssen.
const PUBLIC_PATHS = new Set<string>([
  '/',
  '/staff/login',
  '/portal/login',
  '/portal/login/verify', // Magic-Link-Callback
  '/poa/sign',            // Public PoA-Signatur-Seite (Auth via Token)
  '/gwg-onboarding',      // Public GwG-Onboarding-Wizard (Auth via Token)
  '/api/health',
  '/api/auth', // Auth.js-Routen (alles unter /api/auth/*)
]);

// Pfade, die n8n via signiertem HMAC-Token erreicht (eigener Auth-Pfad).
const N8N_PATH_PREFIX = '/api/n8n';

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const requestId = crypto.randomUUID();

  // 1. n8n-Webhook-Endpoints umgehen die Auth-Cookie-Logik (HMAC im Handler).
  if (pathname.startsWith(N8N_PATH_PREFIX)) {
    return forwardWithHeaders(request, { requestId });
  }

  // 2. Statische Assets und _next-Pfade durchlassen.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/static')
  ) {
    return forwardWithHeaders(request, { requestId });
  }

  // 2b. Host-basiertes Surface-Routing (nur wenn getrennte Domains
  // konfiguriert sind). Die Mandanten-Domain darf NICHT auf der
  // Mitarbeiter-Ansicht landen und umgekehrt — root '/' und falsche
  // Surface-Pfade werden auf die richtige Login-Seite umgeleitet.
  if (PORTAL_HOST && STAFF_HOST && PORTAL_HOST !== STAFF_HOST) {
    const reqHost = (request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
    if (reqHost === PORTAL_HOST && (pathname === '/' || pathname.startsWith(STAFF_PATH_PREFIX))) {
      const u = request.nextUrl.clone();
      u.pathname = PORTAL_LOGIN_PATH;
      u.search = '';
      return NextResponse.redirect(u);
    }
    if (reqHost === STAFF_HOST && pathname.startsWith(PORTAL_PATH_PREFIX)) {
      const u = request.nextUrl.clone();
      u.pathname = STAFF_LOGIN_PATH;
      u.search = '';
      return NextResponse.redirect(u);
    }
  }

  // 3. Public-Pfade durchlassen.
  if (isPublicPath(pathname)) {
    return forwardWithHeaders(request, { requestId });
  }

  // 4. Surface bestimmen.
  const surface = detectSurface(pathname);
  if (!surface) {
    // Unbekannter Pfad — durchlassen, Next.js liefert 404.
    return forwardWithHeaders(request, { requestId });
  }

  // 5. Session-Cookie prüfen.
  const cookieName =
    surface === 'staff' ? STAFF_SESSION_COOKIE : PORTAL_SESSION_COOKIE;
  const session = request.cookies.get(cookieName);
  if (!session?.value) {
    // Nicht eingeloggt → zur Login-Seite des Surface umleiten.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = surface === 'staff' ? STAFF_LOGIN_PATH : PORTAL_LOGIN_PATH;
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // 6. Tenant-Resolution. Strategie:
  //    a) Subdomain (kanzlei.taxtronik.local → slug 'kanzlei')
  //    b) Fallback: leerer Slug → App löst über Default-Tenant auf
  //
  //    Die finale tenant_id-Auflösung passiert im Server-Code (Datenbank-
  //    Lookup), hier wird nur der Slug ermittelt und als Header durchgereicht.
  const tenantSlug = extractTenantSlug(request);

  return forwardWithHeaders(request, {
    requestId,
    surface,
    tenantSlug,
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type Surface = 'staff' | 'portal';

function detectSurface(pathname: string): Surface | null {
  if (pathname.startsWith(STAFF_PATH_PREFIX)) return 'staff';
  if (pathname.startsWith(PORTAL_PATH_PREFIX)) return 'portal';
  // /poa/sign hat eigene Token-Auth, kein Surface
  return null;
}

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Trailing-slash-Varianten und Auth.js-Routen durchlassen.
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/staff/login')) return true;
  if (pathname.startsWith('/portal/login')) return true;
  if (pathname.startsWith('/poa/sign')) return true;
  if (pathname.startsWith('/gwg-onboarding')) return true;
  return false;
}

function extractTenantSlug(request: NextRequest): string | null {
  const host = request.headers.get('host') ?? '';
  // host kann sein: "localhost:3000", "kanzlei.taxtronik.local", "portal.kanzlei.taxtronik.local"
  const hostnameOnly = host.split(':')[0] ?? '';
  const labels = hostnameOnly.split('.');

  // Single-Tenant On-Premise (typischer Fall): Hostname hat 1-2 Labels (z. B. 'localhost'
  // oder 'taxtronik.local'). Tenant wird in der App als Default aufgelöst.
  if (labels.length <= 2) return null;

  // Multi-Subdomain: erstes Label ist Surface oder Slug.
  const first = labels[0]!;
  if (first === 'portal' || first === 'app' || first === 'staff') {
    // Slug ist das zweite Label.
    return labels[1] ?? null;
  }
  // Sonst: erstes Label IST der Slug (z. B. kanzlei.taxtronik.local).
  return first;
}

interface DecorationContext {
  requestId: string;
  surface?: Surface;
  tenantSlug?: string | null;
}

/**
 * K2: Header-Propagation an den Request, nicht an die Response.
 *
 * Vorher setzte `decorate(response.headers.set(...))` die Tenant-/Surface-
 * Header auf der Response — also an den Browser. Das hatte zwei Probleme:
 *  1. Tenant-Slug leakt nach außen (Browser sieht jetzt unsere interne
 *     Tenant-Resolution).
 *  2. Wenn ein zukünftiger Server-Component-Code den Header per
 *     `headers().get('x-taxtronik-tenant-slug')` lesen würde, käme dort gar
 *     nichts an (Request-Header ≠ Response-Header) — und sobald jemand
 *     diesen Lese-Pfad auf einen Client-supplied-Header umstellt, ist die
 *     Tenant-Trennung trivial spoofbar.
 *
 * Lösung: `NextResponse.next({ request: { headers: newRequestHeaders } })`
 * — Next.js merged die übergebenen Header IN den weiterfließenden Request,
 * sodass Server Components / Route Handlers sie via `headers()` lesen können.
 * Die x-request-id stellen wir zusätzlich auf die Response, damit sie im
 * Browser/in Log-Aggregation sichtbar bleibt; Tenant-Slug + Surface bleiben
 * strikt interne Information.
 */
function forwardWithHeaders(request: NextRequest, ctx: DecorationContext): NextResponse {
  const reqHeaders = new Headers(request.headers);
  // N4: Client-supplied Werte für unsere Reservierten Header IMMER strippen,
  // bevor wir ggf. einen eigenen setzen. Sonst können Client-Header auf
  // frühen Return-Pfaden (n8n-Webhooks, statische Assets, Public-Pfade,
  // unbekannte Pfade) ungefiltert weitergereicht werden — sobald irgendwo
  // Server-Code den Header liest, hätten wir eine Spoofing-Lücke.
  reqHeaders.delete('x-request-id');
  reqHeaders.delete('x-taxtronik-surface');
  reqHeaders.delete('x-taxtronik-tenant-slug');

  reqHeaders.set('x-request-id', ctx.requestId);
  if (ctx.surface) reqHeaders.set('x-taxtronik-surface', ctx.surface);
  if (ctx.tenantSlug) reqHeaders.set('x-taxtronik-tenant-slug', ctx.tenantSlug);

  const response = NextResponse.next({ request: { headers: reqHeaders } });
  // Nur Request-ID auf die Response — für Browser/Log-Korrelation.
  response.headers.set('x-request-id', ctx.requestId);
  return response;
}

// -----------------------------------------------------------------------------
// Matcher — gilt für alle Pfade außer statischen Assets.
// -----------------------------------------------------------------------------
export const config = {
  matcher: [
    /*
     * Match alle Pfade außer:
     * - _next/static (statische Dateien)
     * - _next/image (Bild-Optimierung)
     * - favicon.ico, robots.txt
     * - öffentliche Dateien mit Extension
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
