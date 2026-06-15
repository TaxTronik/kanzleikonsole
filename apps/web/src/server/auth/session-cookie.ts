// =============================================================================
// Session-Cookie-Namen (Staff + Portal) - Single Source of Truth.
//
// Haertung: __Host-/__Secure-Prefix nach Auth.js-Standardmuster, aber nur,
// wenn das Cookie auch als Secure-Cookie ausgestellt wird. Browser verwerfen
// Prefix-Cookies in lokalen HTTP-Testlaeufen, deshalb bleibt dort der
// unpraefixte Name.
//
// Bewusst ohne @taxtronik/config-Import: proxy.ts braucht die Namen ebenfalls
// und soll die Zod-Env-Validierung nicht ins Proxy-Bundle ziehen.
// =============================================================================

function isLocalhostUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

function hasLocalHttpE2eUrl(): boolean {
  return [process.env['NEXTAUTH_URL'], process.env['E2E_BASE_URL']].some(isLocalhostUrl);
}

const IS_LOCAL_HTTP_E2E =
  process.env['CI'] === 'true' &&
  process.env['DEV_SKIP_TOTP'] === 'true' &&
  process.env['E2E_ALLOW_DEV_SKIP_TOTP_IN_PRODUCTION'] === 'true' &&
  hasLocalHttpE2eUrl();

export const USE_SECURE_COOKIES = process.env.NODE_ENV === 'production' && !IS_LOCAL_HTTP_E2E;

function sessionCookieName(base: string, cookieDomain: string | undefined): string {
  if (!USE_SECURE_COOKIES) return `__${base}`;
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
