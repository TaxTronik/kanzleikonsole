import { checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';

/** ACCESS-TENANT-RLS-001: All public magic-link entry points limit DB lookups. */
export function checkMagicLinkEntryLimit(requestHeaders: Headers, purpose: 'verify' | 'inspect') {
  return checkIpOrGlobalLimit(
    purpose === 'verify' ? 'portal-authorize' : 'portal-inspect',
    getClientIp(requestHeaders),
    { max: purpose === 'verify' ? 10 : 30, windowSec: 600 },
    { max: purpose === 'verify' ? 200 : 400, windowSec: 600 },
  );
}
