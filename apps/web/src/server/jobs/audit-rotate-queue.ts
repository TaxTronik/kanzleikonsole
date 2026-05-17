// =============================================================================
// BullMQ-Queue für manuell ausgelöste audit-rotate-Jobs.
//
// Singleton-Pattern analog zu n8n/queue.ts. BullMQ erfordert eine eigene
// Connection mit `maxRetriesPerRequest: null` — der zentrale Redis-Singleton
// aus server/redis.ts hat das nicht. Statt pro Klick eine neue Verbindung
// auf-/abzubauen, halten wir hier eine modulweite Connection.
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

interface AuditRotateJob {
  tenantId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __taxtronik_audit_rotate_queue:
    | { conn: IORedis; queue: Queue<AuditRotateJob> }
    | undefined;
}

function init(): { conn: IORedis; queue: Queue<AuditRotateJob> } {
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'audit-rotate-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<AuditRotateJob>('audit-rotate', { connection: conn });
  return { conn, queue };
}

const handle = globalThis.__taxtronik_audit_rotate_queue ?? init();
if (env.NODE_ENV !== 'production') {
  globalThis.__taxtronik_audit_rotate_queue = handle;
}

export const auditRotateQueue = handle.queue;
