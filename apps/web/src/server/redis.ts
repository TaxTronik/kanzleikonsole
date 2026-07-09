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
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_redis: IORedis | null | undefined;
}

/**
 * Verbindungs-Optionen des Singletons. Exportiert, damit ein Regressionstest die
 * Absicht festnagelt (siehe __tests__/redis-options.test.ts).
 *
 * Sicherheitskritische Pfade (rate-limit, nonce-store, totp-replay) sollen bei
 * einem ECHTEN Redis-Ausfall schnell scheitern, damit der Caller seine
 * fail-Strategie (open/closed) anwenden kann. Dafür sorgen `maxRetriesPerRequest`
 * und `commandTimeout` — NICHT `enableOfflineQueue: false`.
 *
 * `enableOfflineQueue: false` war hier ein Bug: zusammen mit `lazyConnect: true`
 * wird das ALLERERSTE Kommando abgelehnt („Stream isn't writeable"), solange der
 * Socket noch verbindet — dasselbe gilt in jedem Reconnect-Fenster. Der
 * Rate-Limiter deutete das als Redis-Exception und lieferte in Produktion
 * fail-closed `retryAfter: 60` → der erste Login nach jedem Prozessstart schlug
 * mit „Zu viele Versuche. Bitte 1 Min. warten." fehl, der sofortige zweite
 * Versuch klappte. Mit aktivierter Offline-Queue wird das Connect-Fenster
 * überbrückt (Kommando wird gepuffert und nach `ready` ausgeführt), während ein
 * echter Ausfall weiterhin in ~60 ms über `maxRetriesPerRequest` abbricht.
 *
 * Kein Bypass-Risiko: ein Kommando wird entweder ausgeführt (Zähler erhöht) oder
 * es wirft (Caller entscheidet fail-closed) — nie „erfolgreich ohne Wirkung".
 */
export const REDIS_OPTIONS = {
  maxRetriesPerRequest: 1,
  // Puffert nur das kurze (Re-)Connect-Fenster, kein Queuen über einen Ausfall:
  // maxRetriesPerRequest/commandTimeout brechen weiterhin schnell ab.
  enableOfflineQueue: true,
  // Backstop gegen eine hergestellte, aber nicht antwortende Verbindung
  // (blockierter Redis) — ohne das hinge ein Login unbegrenzt.
  commandTimeout: 2_000,
  lazyConnect: true,
} as const;

function init(): IORedis | null {
  try {
    const r = new IORedis(env.REDIS_URL, { ...REDIS_OPTIONS });
    r.on('error', () => {
      // Caller loggen den fachlichen Fehler inklusive Fail-Open/Closed-Entscheid.
      // Der Listener verhindert unhandled error events beim Build oder bei Redis-Downtime.
    });
    return r;
  } catch {
    return null;
  }
}

/**
 * Liefert die geteilte Redis-Verbindung oder null wenn die Initialisierung
 * fehlschlug (z. B. fehlerhafte URL beim Start). Aufrufer entscheiden über
 * fail-open vs fail-closed.
 */
export function getRedis(): IORedis | null {
  if (globalThis.__taxtronik_redis === undefined) {
    globalThis.__taxtronik_redis = init();
  }
  return globalThis.__taxtronik_redis ?? null;
}
