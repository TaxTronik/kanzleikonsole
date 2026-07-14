// =============================================================================
// BullMQ-Queue für n8n-Auslieferung (S15 Outbox-Pattern)
//
// Singleton-Queue auf Modul-Ebene. Wird von emit/outbox benutzt, um
// Outbox-Reihen an den Worker weiterzureichen. Lange laufende Connection
// (statt new IORedis pro Call wie in archive/actions.ts), weil das Modul
// pro Server-Lifecycle einmal initialisiert wird.
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

/**
 * Neue Jobs adressieren genau eine Delivery. `outboxId` bleibt als
 * Rolling-Deploy-/Altjob-Variante erhalten; der Worker materialisiert daraus
 * einmalig eine Legacy-Delivery.
 */
export type N8nDeliverJob =
  | { deliveryId: string; outboxId?: never }
  | { outboxId: string; deliveryId?: never };

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_n8n_queue: { conn: IORedis; queue: Queue<N8nDeliverJob> } | undefined;
}

function init(): { conn: IORedis; queue: Queue<N8nDeliverJob> } {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'n8n-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<N8nDeliverJob>('n8n-deliver', { connection: conn });
  return { conn, queue };
}

function getHandle(): { conn: IORedis; queue: Queue<N8nDeliverJob> } {
  const existing = globalThis.__taxtronik_n8n_queue;
  if (existing) return existing;

  const handle = init();
  // IMMER cachen — nicht nur im Dev: ohne Cache öffnet in Produktion jeder
  // Aufruf eine neue IORedis-Connection, die nie geschlossen wird (Leak bis
  // Redis maxclients). globalThis statt Modul-Variable, damit der Handle
  // im Dev auch HMR-Modul-Reloads überlebt.
  globalThis.__taxtronik_n8n_queue = handle;
  return handle;
}

export function getN8nDeliverQueue(): Queue<N8nDeliverJob> {
  return getHandle().queue;
}
