/**
 * ACCESS-TENANT-RLS-001: Auth.js resets `iat` when renewing a cookie. Revocation
 * must retain the original authentication time, including across a renewal
 * racing with a logout. Legacy cookies require a fresh login: their `iat`
 * may already have been advanced by the former renewal behavior.
 */
export function getSessionIssuedAt(token: unknown): number | undefined {
  if (!token || typeof token !== 'object') return undefined;
  const value = (token as { sessionIssuedAt?: unknown }).sessionIssuedAt;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= Math.floor(Date.now() / 1000)
    ? value
    : undefined;
}
