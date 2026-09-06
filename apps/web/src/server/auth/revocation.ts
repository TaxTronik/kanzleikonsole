// =============================================================================
// Session-Revocation (S11)
//
// Hintergrund: JWT-Sessions sind stateless — ohne zusätzlichen Speicher gibt
// es keinen sofortigen Server-Revoke. Bei Compliance-Vorfällen (kompromittierter
// Account, Datenschutzfall, fristlose Kündigung) müssen Tokens trotzdem sofort
// ungültig werden — Warten bis 24h-Ablauf ist nicht akzeptabel.
//
// Ansatz: pro (Surface, UserId) wird in Redis ein Timestamp gespeichert. Tokens,
// deren ursprünglicher Anmeldezeitpunkt (`sessionIssuedAt`) VOR diesem
// Timestamp liegt, gelten als revoked. Cookie-Erneuerungen
// dürfen diesen Vergleichszeitpunkt nicht verschieben.
// Granularität: "logout all sessions for user" — kein Per-Token-Revoke.
//
// Lese- und Schreibpfade sind fail-closed: Ist Redis nicht belastbar
// erreichbar, darf weder ein Widerruf als erfolgreich bestaetigt noch ein
// bestehendes Token als gueltig behandelt werden.
// =============================================================================

// L-5: Singleton-Redis.
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

// 30 Tage — länger als Token-TTL (24h), damit Revocation auch alte Tokens
// erfasst, die noch nicht abgelaufen sind.
const REVOKE_TTL_SEC = 30 * 24 * 60 * 60;

// ACCESS-TENANT-RLS-001: A delayed request or a replica with an older clock
// must never move the cutoff backwards and resurrect already revoked tokens.
// Compare and write atomically; keep unreadable stored state fail-closed.
const ADVANCE_REVOCATION = `
local stored = redis.call('GET', KEYS[1])
local incoming = tonumber(ARGV[1])
if not incoming or incoming <= 0 or incoming > 9007199254740991 or incoming ~= math.floor(incoming) then
  return redis.error_reply('invalid incoming revocation timestamp')
end
if stored then
  local current = tonumber(stored)
  if not current or current <= 0 or current > 9007199254740991 or current ~= math.floor(current) then
    return redis.error_reply('invalid existing revocation timestamp')
  end
  if current > incoming then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
    return 'OK'
  end
end
return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
`;

export type SessionSurface = 'staff' | 'portal';

export class SessionRevocationUnavailableError extends Error {
  constructor(message = 'Session-Widerruf ist derzeit nicht verfügbar.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionRevocationUnavailableError';
  }
}

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
export async function revokeAllSessions(surface: SessionSurface, userId: string): Promise<void> {
  const r = getRedis();
  if (!r) {
    const error = new SessionRevocationUnavailableError();
    log.warn({ component: 'revocation', err: error.message }, 'revoke failed');
    throw error;
  }
  try {
    const result = await r.eval(
      ADVANCE_REVOCATION,
      1,
      key(surface, userId),
      String(Date.now()),
      REVOKE_TTL_SEC,
    );
    if (result !== 'OK') throw new Error(`unexpected Redis revocation result: ${String(result)}`);
  } catch (e) {
    log.warn({ component: 'revocation', err: (e as Error).message }, 'revoke failed');
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
  }
}

/**
 * Liefert den ms-Timestamp, ab dem Tokens für (surface, userId) als revoked
 * gelten. 0 = keine Revocation aktiv. Bei Redis-Ausfall wird abgebrochen;
 * `isTokenRevoked` behandelt diesen Zustand als widerrufen (fail-closed).
 */
export async function getRevocationTimestamp(
  surface: SessionSurface,
  userId: string,
): Promise<number> {
  const r = getRedis();
  if (!r) {
    const error = new SessionRevocationUnavailableError();
    log.warn({ component: 'revocation', err: error.message }, 'revocation timestamp read failed');
    throw error;
  }
  try {
    const v = await r.get(key(surface, userId));
    if (v === null) return 0;
    const timestamp = Number(v);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error('invalid revocation timestamp');
    }
    return timestamp;
  } catch (e) {
    log.warn(
      { component: 'revocation', err: (e as Error).message },
      'revocation timestamp read failed',
    );
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
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
  let revokedMs: number;
  try {
    revokedMs = await getRevocationTimestamp(surface, userId);
  } catch (error) {
    if (error instanceof SessionRevocationUnavailableError) return true;
    throw error;
  }
  if (revokedMs === 0) return false;
  // Ein signiertes Legacy-/Fehlformat-Token ohne belastbares iat darf einen
  // vorhandenen Account-Cutoff nicht umgehen.
  if (typeof tokenIatSec !== 'number' || !Number.isFinite(tokenIatSec)) return true;
  // JWT-iat hat nur Sekundenpraezision. Die gesamte Cutoff-Sekunde gilt als
  // widerrufen; mit `<` bliebe ein Token mit identischem Sekundenwert gueltig,
  // wenn Date.now() exakt auf der Sekundengrenze liegt.
  return tokenIatSec <= Math.floor(revokedMs / 1000);
}
