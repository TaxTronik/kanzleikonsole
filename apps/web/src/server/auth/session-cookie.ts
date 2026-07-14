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

export const STAFF_SESSION_COOKIE_BASE = 'taxtronik_staff_session';
export const PORTAL_SESSION_COOKIE_BASE = 'taxtronik_portal_session';

function deploymentSaltNamespace(): string {
  const explicit = process.env['TAXTRONIK_SESSION_NAMESPACE'];
  if (explicit?.trim()) return explicit.trim();
  const rawUrl =
    process.env['NEXTAUTH_URL'] || process.env['AUTH_URL'] || process.env['E2E_BASE_URL'];
  if (!rawUrl) return 'local';
  try {
    return new URL(rawUrl).origin.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase() || 'local';
  }
}

function sessionJwtSalt(base: string): string {
  return `${base}:${deploymentSaltNamespace()}`;
}

function sessionCookieName(base: string, cookieDomain: string | undefined): string {
  if (!USE_SECURE_COOKIES) return `__${base}`;
  return cookieDomain ? `__Secure-${base}` : `__Host-${base}`;
}

export const STAFF_SESSION_COOKIE = sessionCookieName(
  STAFF_SESSION_COOKIE_BASE,
  process.env['STAFF_COOKIE_DOMAIN'] || undefined,
);

export const PORTAL_SESSION_COOKIE = sessionCookieName(
  PORTAL_SESSION_COOKIE_BASE,
  process.env['PORTAL_COOKIE_DOMAIN'] || undefined,
);

export function sessionCookieNameVariants(base: string): string[] {
  return [`__${base}`, `__Host-${base}`, `__Secure-${base}`];
}

export const STAFF_SESSION_JWT_LEGACY_SALT = STAFF_SESSION_COOKIE_BASE;
export const PORTAL_SESSION_JWT_LEGACY_SALT = PORTAL_SESSION_COOKIE_BASE;

export const STAFF_SESSION_JWT_SALT = sessionJwtSalt(STAFF_SESSION_COOKIE_BASE);
export const PORTAL_SESSION_JWT_SALT = sessionJwtSalt(PORTAL_SESSION_COOKIE_BASE);

export const STAFF_SESSION_JWT_DECODE_SALTS = [
  STAFF_SESSION_JWT_SALT,
  STAFF_SESSION_JWT_LEGACY_SALT,
  STAFF_SESSION_COOKIE,
  ...sessionCookieNameVariants(STAFF_SESSION_COOKIE_BASE),
];

export const PORTAL_SESSION_JWT_DECODE_SALTS = [
  PORTAL_SESSION_JWT_SALT,
  PORTAL_SESSION_JWT_LEGACY_SALT,
  PORTAL_SESSION_COOKIE,
  ...sessionCookieNameVariants(PORTAL_SESSION_COOKIE_BASE),
];
