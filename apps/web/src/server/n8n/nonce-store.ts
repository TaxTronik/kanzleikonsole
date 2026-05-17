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

// L-5: Singleton-Redis.
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

const NONCE_TTL_SEC = 600; // 10 Minuten — > Timestamp-Fenster (2 × 5 min)

/**
 * Prüft + reserviert eine Signatur als bereits gesehen. Returnt:
 *  - `consumed: true` beim ersten Mal (Request darf passieren)
 *  - `consumed: false` beim Replay (Request muss abgewiesen werden)
 *
 * Wenn Redis nicht erreichbar ist, returnt `null` — Caller entscheidet
 * dann strikt: 503 zurück, kein Pass-Through.
 */
export async function consumeNonce(signature: string): Promise<boolean | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    // SET key value NX EX <ttl> — atomar, gibt 'OK' nur beim ersten Aufruf zurück
    const result = await r.set(`n8n-nonce:${signature}`, '1', 'EX', NONCE_TTL_SEC, 'NX');
    return result === 'OK';
  } catch (e) {
    log.warn({ component: 'n8n-nonce', err: (e as Error).message }, 'consume failed');
    return null;
  }
}
