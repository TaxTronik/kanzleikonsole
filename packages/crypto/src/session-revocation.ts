// =============================================================================
// Session-Widerruf (S11) — gemeinsamer Kern für Web und Worker (R-02)
//
// JWT-Sessions sind stateless. Pro (Surface, UserId) liegt deshalb in Redis ein
// ms-Zeitstempel; Tokens, deren ursprünglicher Anmeldezeitpunkt davor liegt,
// gelten als widerrufen. Der Worker schrieb dieselben Keys zuvor mit einer
// eigenen Kopie per `SET … EX` und fail-open; das Web per Lua-Skript monoton
// und fail-closed. Es gilt jetzt überall die strengere Web-Semantik:
//   - monoton: ein verspäteter Aufruf oder eine Replica mit älterer Uhr kann
//     den Cutoff nie zurückschieben und widerrufene Tokens wiederbeleben
//     (ACCESS-TENANT-RLS-001);
//   - fail-closed: ohne belastbar erreichbares Redis wird weder ein Widerruf
//     als erfolgreich bestätigt noch ein Token als gültig behandelt.
// Der Redis-Client kommt vom Aufrufer (Web-Singleton bzw. BullMQ-Verbindung).
// =============================================================================

export type SessionSurface = 'staff' | 'portal';

/** Minimaler, ioredis-kompatibler Zugriff. */
export interface SessionRevocationRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** 30 Tage — länger als die Token-TTL (24 h), damit auch noch gültige Tokens erfasst bleiben. */
export const SESSION_REVOCATION_TTL_SEC = 30 * 24 * 60 * 60;

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

export class SessionRevocationUnavailableError extends Error {
  constructor(message = 'Session-Widerruf ist derzeit nicht verfügbar.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionRevocationUnavailableError';
  }
}

/** Redis-Key-Schema `revoke:<surface>:<userId>` (ohne Prefix, gleiche REDIS_URL in Web und Worker). */
export function sessionRevocationKey(surface: SessionSurface, userId: string): string {
  return `revoke:${surface}:${userId}`;
}

/**
 * Markiert alle bis `nowMs` ausgestellten Sessions von (surface, userId) als
 * widerrufen. Monoton: ein bereits jüngerer Cutoff bleibt bestehen (nur die
 * TTL wird verlängert). Wirft bei jedem Fehler — auch ohne Redis-Client —
 * `SessionRevocationUnavailableError`; ein Widerruf gilt nur nach Rückgabe.
 */
export async function advanceSessionRevocation(
  redis: SessionRevocationRedis | null | undefined,
  surface: SessionSurface,
  userId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    const result = await redis.eval(
      ADVANCE_REVOCATION,
      1,
      sessionRevocationKey(surface, userId),
      String(nowMs),
      SESSION_REVOCATION_TTL_SEC,
    );
    if (result !== 'OK') throw new Error(`unexpected Redis revocation result: ${String(result)}`);
  } catch (e) {
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
  }
}

/**
 * ms-Zeitstempel, ab dem Tokens für (surface, userId) als widerrufen gelten;
 * 0 = kein Widerruf. Wirft `SessionRevocationUnavailableError` bei Ausfall
 * oder unlesbarem Wert (der Aufrufer behandelt das als widerrufen).
 */
export async function readSessionRevocationTimestamp(
  redis: SessionRevocationRedis | null | undefined,
  surface: SessionSurface,
  userId: string,
): Promise<number> {
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    const value = await redis.get(sessionRevocationKey(surface, userId));
    if (value === null) return 0;
    const timestamp = Number(value);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error('invalid revocation timestamp');
    }
    return timestamp;
  } catch (e) {
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
  }
}

/**
 * True, wenn ein Token mit `tokenIatSec` (JWT-iat, Sekunden) vor dem Cutoff
 * `revokedMs` ausgestellt wurde. Ohne belastbares iat gilt ein vorhandener
 * Cutoff als greifend; die gesamte Cutoff-Sekunde gilt als widerrufen.
 */
export function isIssuedBeforeRevocation(
  revokedMs: number,
  tokenIatSec: number | undefined,
): boolean {
  if (revokedMs === 0) return false;
  if (typeof tokenIatSec !== 'number' || !Number.isFinite(tokenIatSec)) return true;
  return tokenIatSec <= Math.floor(revokedMs / 1000);
}
