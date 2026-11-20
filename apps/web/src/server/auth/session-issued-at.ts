import { SessionRevocationUnavailableError } from '@taxtronik/crypto';
import { getRedis } from '@/server/redis';

/**
 * ACCESS-TENANT-RLS-001: Auth.js resets `iat` when renewing a cookie. Revocation
 * must retain the original authentication time, including across a renewal
 * racing with a logout. Legacy cookies require a fresh login: their `iat`
 * may already have been advanced by the former renewal behavior.
 */
export interface SessionIssueTime {
  sessionIssuedAt: number;
  sessionIssuedAtMs?: number;
}

export async function newSessionIssueTime(): Promise<Required<SessionIssueTime>> {
  const redis = getRedis();
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    // Redis TIME liefert Sekunden und Mikrosekunden. Dieselbe Uhr setzt
    // im atomaren Widerrufsskript den Cutoff für Web und Worker.
    const time = await redis.time();
    if (!Array.isArray(time) || time.length !== 2) throw new Error('Invalid Redis time');
    const [seconds, micros] = time;
    if (
      typeof seconds !== 'string' ||
      typeof micros !== 'string' ||
      !/^\d+$/.test(seconds) ||
      !/^\d{1,6}$/.test(micros)
    )
      throw new Error('Invalid Redis time');
    const sessionIssuedAt = Number(seconds);
    const sessionIssuedAtMs = sessionIssuedAt * 1000 + Math.floor(Number(micros) / 1000);
    if (!Number.isSafeInteger(sessionIssuedAtMs) || sessionIssuedAt <= 0)
      throw new Error('Invalid Redis time');
    return { sessionIssuedAt, sessionIssuedAtMs };
  } catch (cause) {
    throw new SessionRevocationUnavailableError(undefined, { cause });
  }
}

export function getSessionIssueTime(token: unknown): SessionIssueTime | undefined {
  if (!token || typeof token !== 'object') return undefined;
  const { sessionIssuedAt, sessionIssuedAtMs } = token as Partial<SessionIssueTime>;
  if (
    typeof sessionIssuedAt !== 'number' ||
    !Number.isSafeInteger(sessionIssuedAt) ||
    sessionIssuedAt <= 0
  )
    return undefined;
  if (sessionIssuedAtMs === undefined) {
    return sessionIssuedAt <= Math.floor(Date.now() / 1000) ? { sessionIssuedAt } : undefined;
  }
  // Präzise Anker stammen von Redis. Den zeitlichen Vergleich übernimmt
  // isTokenRevoked mit derselben Uhr, auch wenn der Web-Host nachgeht.
  if (
    !Number.isSafeInteger(sessionIssuedAtMs) ||
    Math.floor(sessionIssuedAtMs / 1000) !== sessionIssuedAt
  )
    return undefined;
  return { sessionIssuedAt, sessionIssuedAtMs };
}

export function getSessionIssuedAt(token: unknown): number | undefined {
  return getSessionIssueTime(token)?.sessionIssuedAt;
}
