// =============================================================================
// IORedis-Singleton (L-5)
//
// Vorher: jedes Modul (rate-limit, revocation, totp-replay, n8n/nonce-store,
// n8n/queue) instanziierte seine eigene `new IORedis(...)`-Verbindung. Im
// Dev mit HMR potenzieren sich die Connections; in Produktion verbraucht
// jeder unnötige Slots auf dem Redis-Server.
//
// Zentraler Singleton via `globalThis` — Pendant zu prisma-owner.ts.
// =============================================================================

import IORedis from 'ioredis';
import { env } from '@taxtronik/config';

declare global {
  // eslint-disable-next-line no-var
  var __taxtronik_redis: IORedis | null | undefined;
}

function init(): IORedis | null {
  try {
    const r = new IORedis(env.REDIS_URL, {
      // Sicherheitskritische Pfade (rate-limit, nonce-store, totp-replay) wollen
      // schnell scheitern statt zu queuen — bei Redis-Ausfall sollen Caller
      // ihre eigene fail-Strategie (open/closed) anwenden.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    return r;
  } catch {
    return null;
  }
}

if (globalThis.__taxtronik_redis === undefined) {
  globalThis.__taxtronik_redis = init();
}

/**
 * Liefert die geteilte Redis-Verbindung oder null wenn die Initialisierung
 * fehlschlug (z. B. fehlerhafte URL beim Start). Aufrufer entscheiden über
 * fail-open vs fail-closed.
 */
export function getRedis(): IORedis | null {
  return globalThis.__taxtronik_redis ?? null;
}
