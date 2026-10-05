import { checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';

/**
 * ACCESS-TENANT-RLS-001: All public magic-link entry points limit DB lookups.
 * S-03: Without a trusted client IP only the shared storm ceiling applies; the
 * 256-bit tokens make per-token buckets pointless against guessing.
 */
export function checkMagicLinkEntryLimit(requestHeaders: Headers, purpose: 'verify' | 'inspect') {
  return checkIpOrGlobalLimit(
    purpose === 'verify' ? 'portal-authorize' : 'portal-inspect',
    getClientIp(requestHeaders),
    { max: purpose === 'verify' ? 10 : 30, windowSec: 600 },
  );
}
