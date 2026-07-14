// =============================================================================
// Replay-Schutz-Nonce-Store für eingehende n8n-Webhooks (S3)
//
// Strategie: jeder signierte Request hat einen Timestamp (innerhalb ±5min)
// und die Signatur dient als Nonce. Beim ersten Eintreffen merken wir uns
// die Signatur in Redis mit TTL > Replay-Fenster. Ein zweiter Aufruf mit
// derselben Signatur wird als Replay erkannt und abgewiesen.
//
// Fail-Mode bei nicht erreichbarem Redis: fail-CLOSED. Anders als beim
// Rate-Limit (UX-Schutz) ist Replay-Schutz security-kritisch und darf
// nicht stillschweigend übergangen werden.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

const NONCE_TTL_SEC = 600;
const RELEASE_IF_OWNED_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface N8nNonceReservation {
  key: string;
  owner: string;
}

/**
 * Reserviert eine bereits authentifizierte Signatur unmittelbar vor der
 * Operation. Returnt die owner-gebundene Reservation beim ersten Aufruf,
 * `false` beim Replay und `null`, wenn Redis nicht erreichbar ist.
 *
 * Wenn Redis nicht erreichbar ist, returnt `null` — Caller entscheidet
 * dann strikt: 503 zurück, kein Pass-Through.
 */
export async function reserveNonce(signature: string): Promise<N8nNonceReservation | false | null> {
  const r = getRedis();
  if (!r) return null;

  const reservation = {
    key: `n8n-nonce:${signature}`,
    owner: randomUUID(),
  };

  try {
    const result = await r.set(reservation.key, reservation.owner, 'EX', NONCE_TTL_SEC, 'NX');
    return result === 'OK' ? reservation : false;
  } catch (e) {
    log.warn({ component: 'n8n-nonce', err: (e as Error).message }, 'reserve failed');
    return null;
  }
}

/** Gibt ausschliesslich die von diesem Aufruf gehaltene Reservation frei. */
export async function releaseNonce(reservation: N8nNonceReservation): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;

  try {
    const result = await r.eval(RELEASE_IF_OWNED_SCRIPT, 1, reservation.key, reservation.owner);
    return result === 1;
  } catch (e) {
    log.warn({ component: 'n8n-nonce', err: (e as Error).message }, 'release failed');
    return false;
  }
}
