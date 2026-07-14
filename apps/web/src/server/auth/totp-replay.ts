// =============================================================================
// TOTP-Replay-Schutz (H5)
//
// `authenticator.verify(...)` aus otplib akzeptiert jeden Code innerhalb des
// gültigen 30-s-Fensters (plus ±1 Toleranzfenster). Ein per Shoulder-Surfing
// oder Mitm abgefangener Code kann bis zum Fensterwechsel ein zweites Mal
// genutzt werden.
//
// Fix: jeder erfolgreich verifizierte Code wird pro (staffId, fensterID)
// in Redis für 90 s als „spent" markiert. Zweiter Login-Versuch mit demselben
// Code → reject.
//
// Fail-Mode bei Redis-Ausfall: fail-CLOSED. TOTP-Replay-Schutz ist Security-
// kritisch — bei Redis-Downtime wird TOTP-Login blockiert. Akzeptabel, weil
// die meisten Compliance-Operationen Redis ohnehin brauchen (Rate-Limit,
// Nonce-Store, Revocation).
// =============================================================================

// L-5: Singleton-Redis.
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

// TTL > 2 × 30s Fenster + Toleranz-Window. 90s deckt Window±1 ab.
const TOTP_REPLAY_TTL_SEC = 90;

/**
 * Markiert (staffId, code) als verwendet. Returnt:
 *  - true beim ersten Mal (Login darf passieren)
 *  - false beim Replay (Login muss abgewiesen werden)
 *  - null bei Redis-Ausfall (Caller entscheidet — empfohlen: fail-closed)
 */
export async function consumeTotpCode(staffId: string, code: string): Promise<boolean | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const result = await r.set(
      `totp-used:${staffId}:${code}`,
      '1',
      'EX',
      TOTP_REPLAY_TTL_SEC,
      'NX',
    );
    return result === 'OK';
  } catch (e) {
    log.warn({ component: 'totp-replay', err: (e as Error).message }, 'consume failed');
    return null;
  }
}
