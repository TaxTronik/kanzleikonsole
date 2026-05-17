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

export interface N8nDeliverJob {
  outboxId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __taxtronik_n8n_queue:
    | { conn: IORedis; queue: Queue<N8nDeliverJob> }
    | undefined;
}

function init(): { conn: IORedis; queue: Queue<N8nDeliverJob> } {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'n8n-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<N8nDeliverJob>('n8n-deliver', { connection: conn });
  return { conn, queue };
}

const handle = globalThis.__taxtronik_n8n_queue ?? init();
if (env.NODE_ENV !== 'production') {
  globalThis.__taxtronik_n8n_queue = handle;
}

export const n8nDeliverQueue = handle.queue;
