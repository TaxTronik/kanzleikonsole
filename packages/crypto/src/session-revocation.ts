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
//
// Globaler Stichtag `revoke:all`: Geht in Redis Zustand verloren (älterer
// Snapshot zurückgespielt, Failover auf ein Replikat ohne die letzten
// Schreibvorgänge), würden bereits widerrufene Sitzungen wieder gültig. Der
// Betreiber setzt dann mit `./taxtronik revoke-all-sessions` einen Stichtag,
// der für alle Personen beider Oberflächen gilt. Jede Prüfung liest ihn mit.
// =============================================================================

export type SessionSurface = 'staff' | 'portal';

/** Minimaler, ioredis-kompatibler Zugriff. */
export interface SessionRevocationRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/** 30 Tage — länger als die Token-TTL (24 h), damit auch noch gültige Tokens erfasst bleiben. */
export const SESSION_REVOCATION_TTL_SEC = 30 * 24 * 60 * 60;

const REDIS_TIME_MS = `
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
`;

const READ_REVOCATION_STATE = `${REDIS_TIME_MS}
return {redis.call('GET', KEYS[1]), redis.call('GET', KEYS[2]), nowMs}
`;

// Compare and write atomically; keep unreadable stored state fail-closed.
// scripts/ops/sessions.sh führt für `revoke:all` wörtlich dasselbe Skript aus
// (geprüft in session-revocation.test.ts).
export const ADVANCE_REVOCATION = `${REDIS_TIME_MS}
local stored = redis.call('GET', KEYS[1])
local incoming = nowMs
if stored then
  local current = tonumber(stored)
  if not current or current <= 0 or current > 9007199254740991 or current ~= math.floor(current) then
    return redis.error_reply('invalid existing revocation timestamp')
  end
  if current > incoming then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return 'OK'
  end
end
return redis.call('SET', KEYS[1], string.format('%.0f', incoming), 'EX', ARGV[1])
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

/** Globaler Stichtag für alle Personen beider Oberflächen (Betreiber, nach Redis-Verlust). */
export const GLOBAL_SESSION_REVOCATION_KEY = 'revoke:all';

/**
 * Widerruft alle bis zur Redis-Serverzeit ausgestellten Sitzungen beider
 * Oberflächen. Monoton und fail-closed wie `advanceSessionRevocation`.
 */
export async function advanceGlobalSessionRevocation(
  redis: SessionRevocationRedis | null | undefined,
): Promise<void> {
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    const result = await redis.eval(
      ADVANCE_REVOCATION,
      1,
      GLOBAL_SESSION_REVOCATION_KEY,
      SESSION_REVOCATION_TTL_SEC,
    );
    if (result !== 'OK') throw new Error(`unexpected Redis revocation result: ${String(result)}`);
  } catch (e) {
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
  }
}

/**
 * Markiert alle bis zur Redis-Serverzeit ausgestellten Sessions von (surface, userId) als
 * widerrufen. Monoton: ein bereits jüngerer Cutoff bleibt bestehen (nur die
 * TTL wird verlängert). Wirft bei jedem Fehler — auch ohne Redis-Client —
 * `SessionRevocationUnavailableError`; ein Widerruf gilt nur nach Rückgabe.
 */
export async function advanceSessionRevocation(
  redis: SessionRevocationRedis | null | undefined,
  surface: SessionSurface,
  userId: string,
): Promise<void> {
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    const result = await redis.eval(
      ADVANCE_REVOCATION,
      1,
      sessionRevocationKey(surface, userId),
      SESSION_REVOCATION_TTL_SEC,
    );
    if (result !== 'OK') throw new Error(`unexpected Redis revocation result: ${String(result)}`);
  } catch (e) {
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
  }
}

/**
 * ms-Zeitstempel, ab dem Tokens für (surface, userId) als widerrufen gelten:
 * der spätere aus persönlichem und globalem Stichtag; 0 = kein Widerruf.
 * Wirft `SessionRevocationUnavailableError` bei Ausfall oder unlesbarem Wert
 * (der Aufrufer behandelt das als widerrufen).
 */
export async function readSessionRevocationTimestamp(
  redis: SessionRevocationRedis | null | undefined,
  surface: SessionSurface,
  userId: string,
): Promise<number> {
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    const personal = parseCutoff(await redis.get(sessionRevocationKey(surface, userId)));
    const global = parseCutoff(await redis.get(GLOBAL_SESSION_REVOCATION_KEY));
    return Math.max(personal, global);
  } catch (e) {
    throw new SessionRevocationUnavailableError(undefined, { cause: e });
  }
}

function parseCutoff(value: unknown): number {
  if (value === null) return 0;
  const timestamp = Number(value);
  if (typeof value !== 'string' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('invalid revocation timestamp');
  }
  return timestamp;
}

/**
 * Ein Redis-Aufruf liefert persönlichen und globalen Widerruf sowie die
 * Vergleichsuhr für präzise Anmeldeanker. `cutoffMs` ist der spätere Stichtag.
 */
export async function readSessionRevocationState(
  redis: SessionRevocationRedis | null | undefined,
  surface: SessionSurface,
  userId: string,
): Promise<{ cutoffMs: number; nowMs: number }> {
  if (!redis) throw new SessionRevocationUnavailableError();
  try {
    const state = await redis.eval(
      READ_REVOCATION_STATE,
      2,
      sessionRevocationKey(surface, userId),
      GLOBAL_SESSION_REVOCATION_KEY,
    );
    if (!Array.isArray(state) || state.length !== 3) throw new Error('invalid Redis state');
    const [personal, global, nowMs] = state;
    if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs <= 0)
      throw new Error('invalid Redis time');
    return { cutoffMs: Math.max(parseCutoff(personal), parseCutoff(global)), nowMs };
  } catch (cause) {
    throw new SessionRevocationUnavailableError(undefined, { cause });
  }
}

/**
 * True, wenn ein Token mit `tokenIatSec` (JWT-iat, Sekunden) vor dem Cutoff
 * `revokedMs` ausgestellt wurde. Ohne belastbares iat gilt ein vorhandener
 * Cutoff als greifend. Ohne Millisekundenangabe bleibt die gesamte
 * Cutoff-Sekunde widerrufen.
 */
export function isIssuedBeforeRevocation(
  revokedMs: number,
  tokenIatSec: number | undefined,
  tokenIatMs?: number,
): boolean {
  if (revokedMs === 0 && tokenIatMs === undefined) return false;
  if (typeof tokenIatSec !== 'number' || !Number.isSafeInteger(tokenIatSec)) return true;
  if (tokenIatMs === undefined) return tokenIatSec <= Math.floor(revokedMs / 1000);
  if (!Number.isSafeInteger(tokenIatMs) || Math.floor(tokenIatMs / 1000) !== tokenIatSec)
    return true;
  return tokenIatMs <= revokedMs;
}
