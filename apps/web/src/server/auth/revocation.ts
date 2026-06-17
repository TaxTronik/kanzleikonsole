// =============================================================================
// Session-Revocation (S11)
//
// Hintergrund: JWT-Sessions sind stateless — ohne zusätzlichen Speicher gibt
// es keinen sofortigen Server-Revoke. Bei Compliance-Vorfällen (kompromittierter
// Account, Datenschutzfall, fristlose Kündigung) müssen Tokens trotzdem sofort
// ungültig werden — Warten bis 24h-Ablauf ist nicht akzeptabel.
//
// Ansatz: pro (Surface, UserId) wird in Redis ein Timestamp gespeichert. Tokens,
// die VOR diesem Timestamp ausgestellt wurden (`token.iat`), gelten als revoked.
// Granularität: "logout all sessions for user" — kein Per-Token-Revoke.
//
// Fail-Mode bei Redis-Ausfall: fail-OPEN (Login funktioniert weiter). Ein
// fail-closed-Verhalten würde bei Redis-Downtime alle Logins blockieren —
// nicht akzeptabel für eine On-Premise-Compliance-Software. JWT-TTL von 24h
// begrenzt das Worst-Case-Fenster.
// =============================================================================

// L-5: Singleton-Redis.
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

// 30 Tage — länger als Token-TTL (24h), damit Revocation auch alte Tokens
// erfasst, die noch nicht abgelaufen sind.
const REVOKE_TTL_SEC = 30 * 24 * 60 * 60;

export type SessionSurface = 'staff' | 'portal';

function key(surface: SessionSurface, userId: string): string {
  return `revoke:${surface}:${userId}`;
}

/**
 * Markiert alle bisher ausgestellten Sessions für (surface, userId) als revoked.
 * Wird typischerweise aufgerufen bei:
 *  - Account-Deaktivierung
 *  - Rollen-Reduktion
 *  - Passwort-Reset
 *  - Admin-Aktion „alle Sessions ausloggen"
 */
export async function revokeAllSessions(
  surface: SessionSurface,
  userId: string,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key(surface, userId), String(Date.now()), 'EX', REVOKE_TTL_SEC);
  } catch (e) {
    log.warn({ component: 'revocation', err: (e as Error).message }, 'revoke failed');
  }
}

/**
 * Liefert den ms-Timestamp, ab dem Tokens für (surface, userId) als revoked
 * gelten. 0 = keine Revocation aktiv. Bei Redis-Ausfall: 0 (fail-open).
 */
export async function getRevocationTimestamp(
  surface: SessionSurface,
  userId: string,
): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  try {
    const v = await r.get(key(surface, userId));
    if (!v) return 0;
    return Number(v) || 0;
  } catch (e) {
    log.warn(
      { component: 'revocation', err: (e as Error).message },
      'revocation timestamp read failed',
    );
    return 0;
  }
}

/**
 * Prüft, ob ein Token mit `tokenIatSec` (iat-Claim in Sekunden seit Epoch)
 * für (surface, userId) revoked ist.
 */
export async function isTokenRevoked(
  surface: SessionSurface,
  userId: string,
  tokenIatSec: number | undefined,
): Promise<boolean> {
  if (!tokenIatSec) return false;
  const revokedMs = await getRevocationTimestamp(surface, userId);
  if (revokedMs === 0) return false;
  return tokenIatSec * 1000 < revokedMs;
}
