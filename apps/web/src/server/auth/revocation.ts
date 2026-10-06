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
import {
  advanceSessionRevocation,
  isIssuedBeforeRevocation,
  readSessionRevocationTimestamp,
  SessionRevocationUnavailableError,
  type SessionSurface,
} from '@taxtronik/crypto';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

// R-02: Lua-Skript (monoton, ACCESS-TENANT-RLS-001), Key-Schema, TTL und
// Fehlerklasse liegen in @taxtronik/crypto — derselbe Kern schreibt auch die
// Portal-Widerrufe des Workers (gwg-expiry-check). Hier bleiben nur der
// Web-Redis-Singleton und das Logging.
export { SessionRevocationUnavailableError, type SessionSurface };

/**
 * Markiert alle bisher ausgestellten Sessions für (surface, userId) als revoked.
 * Wird typischerweise aufgerufen bei:
 *  - Account-Deaktivierung
 *  - Rollen-Reduktion
 *  - Passwort-Reset
 *  - Admin-Aktion „alle Sessions ausloggen"
 */
export async function revokeAllSessions(surface: SessionSurface, userId: string): Promise<void> {
  try {
    await advanceSessionRevocation(getRedis(), surface, userId);
  } catch (e) {
    const cause = (e as Error).cause;
    log.warn(
      { component: 'revocation', err: ((cause as Error | undefined) ?? (e as Error)).message },
      'revoke failed',
    );
    throw e;
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
  try {
    return await readSessionRevocationTimestamp(getRedis(), surface, userId);
  } catch (e) {
    const cause = (e as Error).cause;
    log.warn(
      { component: 'revocation', err: ((cause as Error | undefined) ?? (e as Error)).message },
      'revocation timestamp read failed',
    );
    throw e;
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
  // Ein signiertes Legacy-/Fehlformat-Token ohne belastbares iat darf einen
  // vorhandenen Account-Cutoff nicht umgehen. JWT-iat hat nur Sekunden-
  // praezision: die gesamte Cutoff-Sekunde gilt als widerrufen.
  return isIssuedBeforeRevocation(revokedMs, tokenIatSec);
}
